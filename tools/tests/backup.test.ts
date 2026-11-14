import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";

// Бэкапы, проверка восстановления и алерты (SH-012). Сам wal-g, бакет VK Cloud, Telegram с VPS, UptimeRobot
// и восстановление на prod проверяются вручную (план тестов задачи). Здесь проверяются конфигурация compose,
// шаблон .env и порядок команд в скриптах infra/backup на подменённых docker, curl и df.

const repoRoot = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");
const script = (name: string) => join(repoRoot, "infra/backup", name);

type Compose = { services: Record<string, Record<string, unknown>> };
const compose = () => YAML.parse(read("infra/docker-compose.prod.yml")) as Compose;

// Без этих шести значений wal-g не работает; скрипты бэкапа и install.sh проверяют каждое.
const REQUIRED_BACKUP_NAMES = [
  "WALG_S3_PREFIX",
  "AWS_ENDPOINT",
  "AWS_REGION",
  "AWS_ACCESS_KEY_ID",
  "AWS_SECRET_ACCESS_KEY",
  "WALG_LIBSODIUM_KEY",
];
const TOKEN = "123456:SECRET-BOT-TOKEN";
const SECRETS = ["SECRET-PASS", "SECRET-KEY-ID", "SECRET-ACCESS", "SECRET-ENC-KEY"];
const ENV_FILE = [
  "DOMAIN=example.test",
  "POSTGRES_USER=studhub",
  "POSTGRES_DB=studhub",
  "POSTGRES_PASSWORD=SECRET-PASS",
  "",
].join("\n");
// Ключи бэкапа лежат в отдельном файле .env.backup: контейнер app его не читает.
const BACKUP_ENV_FILE = [
  "WALG_S3_PREFIX=s3://bucket-test/prod",
  "AWS_ENDPOINT=https://s3.example.test",
  "AWS_REGION=ru-msk",
  "AWS_ACCESS_KEY_ID=SECRET-KEY-ID",
  "AWS_SECRET_ACCESS_KEY=SECRET-ACCESS",
  "WALG_LIBSODIUM_KEY=SECRET-ENC-KEY",
  "",
].join("\n");
// Настройки Telegram лежат в отдельном файле .env.telegram: его читают только скрипты на хосте, контейнер postgres не получает.
// Алерты идут через прокси: токен бота хранится только в Cloudflare, в этом файле его нет.
const TELEGRAM_ENV_FILE = [
  "TELEGRAM_API_URL=https://telegram.example.test",
  "TELEGRAM_PROXY_SECRET=PROXY-SHARED-SECRET",
  "",
].join("\n");

describe("compose и шаблон .env", () => {
  const postgres = () => compose().services.postgres ?? {};
  const command = () => [postgres().command].flat().join(" ");
  const environment = () => (postgres().environment ?? {}) as Record<string, string>;

  it("[SH-012 AC-1] Postgres архивирует WAL через wal-g", () => {
    expect(command()).toContain("archive_mode=on");
    expect(command()).toMatch(/archive_command=(timeout \d+ )?\S*wal-g wal-push %p/);
    expect(command()).toMatch(/archive_timeout=\d+/);
  });

  it("[SH-012 AC-1] зависший wal-push не блокирует архивацию бесконечно: archive_command с timeout", () => {
    expect(command()).toMatch(/archive_command=timeout \d+ \S*wal-g wal-push %p/);
  });

  it("[SH-012 AC-1] контейнер postgres доверяет корневым сертификатам хоста: файл смонтирован и задан SSL_CERT_FILE", () => {
    const volumes = (postgres().volumes ?? []) as string[];
    expect(volumes).toContain("/etc/ssl/certs/ca-certificates.crt:/etc/ssl/certs/ca-certificates.crt:ro");
    expect(environment().SSL_CERT_FILE).toBe("/etc/ssl/certs/ca-certificates.crt");
  });

  it("[SH-012 AC-1] бинарник wal-g монтируется в контейнер только на чтение, порт Postgres наружу не открыт", () => {
    const volumes = (postgres().volumes ?? []) as string[];
    expect(volumes.some((volume) => /^\.\/bin:\/opt\/walg:ro$/.test(volume))).toBe(true);
    expect(postgres().ports).toBeUndefined();
  });

  const BACKUP_NAMES = [
    "WALG_S3_PREFIX",
    "AWS_ENDPOINT",
    "AWS_REGION",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "WALG_LIBSODIUM_KEY",
  ];
  const envFiles = (service: string) => [compose().services[service]?.env_file ?? []].flat() as string[];

  it("[SH-012 AC-1] wal-g шифрует libsodium и берёт данные бакета из WALG_* и AWS_*, а не из S3_*", () => {
    const env = environment();
    expect(env.WALG_LIBSODIUM_KEY_TRANSFORM).toBe("hex");
    expect(String(env.AWS_S3_FORCE_PATH_STYLE)).toBe("true");
    const example = read("infra/.env.backup.example");
    for (const name of BACKUP_NAMES) expect(example, name).toMatch(new RegExp(`^${name}=$`, "m"));
    expect(example).not.toMatch(/^S3_/m);
    expect(JSON.stringify(env)).not.toMatch(/\$\{S3_/);
  });

  it("[SH-012 AC-1] compose не стартует без ключа шифрования и данных бакета: они обязательны в .env.backup", () => {
    expect(envFiles("postgres")).toContain(".env.backup");
    // Секреты не вписаны в compose: ни значений, ни подстановок из .env.
    for (const name of BACKUP_NAMES) expect(environment()[name], name).toBeUndefined();
  });

  it("[SH-012 AC-1] контейнер app не получает ключи бэкапа: он не читает .env.backup и не подставляет WALG_*, AWS_*, TELEGRAM_*", () => {
    const app = compose().services.app ?? {};
    expect(envFiles("app")).not.toContain(".env.backup");
    expect(JSON.stringify(app)).not.toMatch(/WALG_|AWS_|TELEGRAM_/);
    expect(envFiles("caddy")).not.toContain(".env.backup");
  });

  it("[SH-012 AC-1] контейнер postgres получает только ключи wal-g: .env.backup без TELEGRAM_*, файл .env.telegram не читает ни один сервис", () => {
    expect(envFiles("postgres")).toEqual([".env.backup"]);
    expect(JSON.stringify(postgres())).not.toMatch(/TELEGRAM_/);
    for (const service of Object.keys(compose().services)) {
      expect(envFiles(service), service).not.toContain(".env.telegram");
    }
    const example = read("infra/.env.backup.example");
    expect(example).not.toMatch(/TELEGRAM_/);
    const names = [...example.matchAll(/^([A-Z][A-Z0-9_]*)=/gm)].map((match) => match[1]);
    expect(names.sort()).toEqual([...BACKUP_NAMES].sort());
  });

  it("[SH-012 AC-1, AC-3] шаблон .env.telegram.example содержит пустые TELEGRAM_*, а .env.prod.example их не содержит", () => {
    const example = read("infra/.env.telegram.example");
    for (const name of ["TELEGRAM_API_URL", "TELEGRAM_PROXY_SECRET", "TELEGRAM_CHAT_ID", "TELEGRAM_BOT_TOKEN"]) {
      expect(example, name).toMatch(new RegExp(`^${name}=$`, "m"));
    }
    expect(example).not.toMatch(/^(WALG_|AWS_)\w*=/m);
    expect(read("infra/.env.prod.example")).not.toMatch(/^(WALG_|AWS_|TELEGRAM_)\w*=/m);
  });
});

// Запуск install.sh на подменённых sudo, curl, tar и sha256sum: ничего не скачивается и не ставится в систему.
// Без аргументов в каталоге лежат корректные .env, .env.backup и .env.telegram; null вместо файла не создаёт его.
type InstallFiles = { env?: string; backup?: string; telegram?: string | null; telegramMode?: number };
function installRun(files: InstallFiles = {}, extraEnv: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "install-"));
  const bin = join(dir, "fakebin");
  const log = join(dir, "calls.log");
  mkdirSync(bin);
  const put = (name: string, body: string, mode = 0o600) => {
    writeFileSync(join(dir, name), body);
    chmodSync(join(dir, name), mode);
  };
  put(".env", files.env ?? ENV_FILE);
  put(".env.backup", files.backup ?? BACKUP_ENV_FILE.replace("SECRET-ENC-KEY", "a".repeat(64)));
  if (files.telegram !== null) put(".env.telegram", files.telegram ?? TELEGRAM_ENV_FILE, files.telegramMode ?? 0o600);
  const fake = (name: string, lines: string[]) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${lines.join("\n")}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  fake("sudo", [`echo "sudo $*" >> "${log}"`, "cat > /dev/null"]);
  fake("curl", ['out=""', 'while [ $# -gt 0 ]; do [ "$1" = -o ] && out="$2"; shift; done', 'echo archive > "$out"']);
  fake("sha256sum", ["cat > /dev/null"]);
  fake("tar", [
    'dir=""',
    'while [ $# -gt 0 ]; do [ "$1" = -C ] && dir="$2"; shift; done',
    'printf "#!/usr/bin/env bash\\necho wal-g fake\\n" > "$dir/wal-g-pg-24.04-amd64"',
    'chmod +x "$dir/wal-g-pg-24.04-amd64"',
  ]);
  const result = spawnSync("bash", [script("install.sh")], {
    encoding: "utf8",
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH}`,
      DEPLOY_DIR: dir,
      CA_BUNDLE: join(dir, ".env"),
      BACKUP_LOG: join(dir, "studhub-backup.log"),
      ...extraEnv,
    },
  });
  const calls = existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
  return { dir, result, calls, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}
// Выполняет сценарий и всегда убирает временный каталог.
function installCheck<T>(
  files: InstallFiles,
  check: (run: ReturnType<typeof installRun>) => T,
  extraEnv: Record<string, string> = {},
) {
  const run = installRun(files, extraEnv);
  try {
    return check(run);
  } finally {
    run.cleanup();
  }
}

describe("cron, установка и выкладка", () => {
  const cron = () =>
    read("infra/backup/studhub-backup.cron")
      .split("\n")
      .filter((line) => line.trim() && !line.trim().startsWith("#"));

  it("[SH-012 AC-1] cron раз в сутки запускает полный бэкап", () => {
    const line = cron().find((entry) => entry.includes("full-backup.sh"));
    expect(line, "нет строки full-backup.sh").toBeDefined();
    expect(line).toMatch(/^\d+\s+\d+\s+\*\s+\*\s+\*\s+deploy\s/);
  });

  it("[SH-012 AC-2] cron раз в неделю запускает проверку восстановления", () => {
    const line = cron().find((entry) => entry.includes("restore-check.sh"));
    expect(line, "нет строки restore-check.sh").toBeDefined();
    expect(line).toMatch(/^\d+\s+\d+\s+\*\s+\*\s+[0-7]\s+deploy\s/);
  });

  it("[SH-012 AC-3] cron запускает алерты не реже раза в 15 минут", () => {
    const line = cron().find((entry) => entry.includes("alerts.sh"));
    expect(line, "нет строки alerts.sh").toBeDefined();
    expect(line).toMatch(/^\*\/(\d+)\s/);
    expect(Number(line?.match(/^\*\/(\d+)/)?.[1])).toBeLessThanOrEqual(15);
  });

  it("[SH-012 AC-1] install.sh ставит wal-g зафиксированной версии и проверяет контрольную сумму", () => {
    const text = read("infra/backup/install.sh");
    expect(text).toMatch(/WALG_VERSION=v\d+\.\d+\.\d+/);
    expect(text).toMatch(/WALG_SHA256=[0-9a-f]{64}/);
    expect(text).toContain("sha256sum");
  });

  it("[SH-012 AC-1] install.sh отказывается работать, если ключи бэкапа остались в .env (его читает app)", () => {
    installCheck({ env: `${ENV_FILE}AWS_ACCESS_KEY_ID=SECRET-KEY-ID\n` }, ({ result }) => {
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(".env.backup");
      expect(result.stderr).toContain("AWS_ACCESS_KEY_ID");
      expect(result.stderr).not.toContain("SECRET-KEY-ID");
    });
  });

  // Каждое значение проверяется отдельно: и когда строки нет в .env.backup, и когда значение пустое.
  const withoutValue = (name: string, mode: "removed" | "empty") =>
    BACKUP_ENV_FILE.replace("SECRET-ENC-KEY", "a".repeat(64))
      .split("\n")
      .flatMap((line) => (line.startsWith(`${name}=`) ? (mode === "empty" ? [`${name}=`] : []) : [line]))
      .join("\n");

  for (const name of REQUIRED_BACKUP_NAMES) {
    for (const mode of ["removed", "empty"] as const) {
      it(`[SH-012 AC-1] install.sh отказывается работать, если в .env.backup ${mode === "empty" ? "пусто" : "нет"} ${name}`, () => {
        installCheck({ backup: withoutValue(name, mode) }, ({ result }) => {
          expect(result.status).not.toBe(0);
          expect(result.stderr).toContain("В .env.backup не заданы");
          expect(result.stderr).toContain(name);
        });
      });
    }
  }

  it("[SH-012 AC-1] install.sh с корректными файлами проходит до конца и ставит расписание", () => {
    installCheck({}, ({ result, calls }) => {
      expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      expect(calls.some((line) => line.includes("/etc/cron.d/studhub-backup"))).toBe(true);
    });
  });

  it("[SH-012 AC-1] install.sh отказывается работать без файла корневых сертификатов хоста", () => {
    const result = spawnSync("bash", [script("install.sh")], {
      encoding: "utf8",
      env: { ...process.env, DEPLOY_DIR: tmpdir(), CA_BUNDLE: "/nonexistent/ca.crt" },
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("ca-certificates");
  });

  it("[SH-012 AC-1] install.sh не стирает существующий журнал бэкапа при повторном запуске", () => {
    const run = installRun({}, {});
    try {
      // Первый запуск: журнала нет, скрипт создаёт его.
      expect(run.result.status).toBe(0);
      expect(run.calls.some((line) => line.includes("/dev/null") && line.includes("studhub-backup.log"))).toBe(true);
    } finally {
      run.cleanup();
    }
    const dir = mkdtempSync(join(tmpdir(), "install-log-"));
    try {
      const logFile = join(dir, "existing.log");
      writeFileSync(logFile, "старая запись\n");
      installCheck(
        {},
        ({ result, calls }) => {
          expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
          expect(calls.some((line) => line.includes("/dev/null") && line.includes(logFile))).toBe(false);
        },
        { BACKUP_LOG: logFile },
      );
      expect(readFileSync(logFile, "utf8")).toBe("старая запись\n");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("[SH-012 AC-1] CI копирует infra/backup на сервер вместе с compose", () => {
    const workflow = read(".github/workflows/ci.yml");
    expect(workflow).toMatch(/scp[^\n]*-r[\s\S]*?infra\/backup/);
  });
});

// Подменённые docker, curl и df пишут вызовы в журнал. Сценарий задают переменные FAKE_*.
type Fixture = {
  dir: string;
  bin: string;
  log: string;
  state: string;
  run: (name: string, args?: string[], env?: Record<string, string>) => ReturnType<typeof spawnSync>;
  calls: () => string[];
  text: (result: ReturnType<typeof spawnSync>) => string;
};

function fixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "backup-"));
  const bin = join(dir, "bin");
  const log = join(dir, "calls.log");
  const state = join(dir, "state");
  mkdirSync(bin);
  mkdirSync(state);
  writeFileSync(join(dir, "docker-compose.prod.yml"), "name: studhub\n");
  writeFileSync(join(dir, ".env"), ENV_FILE);
  chmodSync(join(dir, ".env"), 0o600);
  writeFileSync(join(dir, ".env.backup"), BACKUP_ENV_FILE);
  chmodSync(join(dir, ".env.backup"), 0o600);
  writeFileSync(join(dir, ".env.telegram"), TELEGRAM_ENV_FILE);
  chmodSync(join(dir, ".env.telegram"), 0o600);

  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // docker: FAKE_FAIL_ON — подстрока вызова, на которой команда падает. Счёт строк берётся из файлов FAKE_PROD_COUNTS и FAKE_RESTORED_COUNTS.
  fake(
    "docker",
    `echo "docker $*" >> "${log}"
if [ -n "\${FAKE_FAIL_ON:-}" ] && [[ "$*" == *"$FAKE_FAIL_ON"* ]]; then exit 1; fi
if [ -n "\${FAKE_TIMEOUT_ON:-}" ] && [[ "$*" == *"$FAKE_TIMEOUT_ON"* ]]; then exit 124; fi
if [[ "$*" == *"pg_stat_archiver"* ]]; then
  [ -n "\${FAKE_ARCHIVER_EXIT:-}" ] && exit "$FAKE_ARCHIVER_EXIT"
  echo "\${FAKE_ARCHIVER:-0|120}"
  exit 0
fi
if [[ "$*" == *"backup-list"* ]]; then
  [ -n "\${FAKE_LIST_EXIT:-}" ] && exit "$FAKE_LIST_EXIT"
  cat "\${FAKE_BACKUP_LIST:-/dev/null}"
  exit 0
fi
if [[ "$*" == *"query_to_xml"* ]]; then
  if [[ "$*" == compose* ]]; then cat "\${FAKE_PROD_COUNTS}"; else cat "\${FAKE_RESTORED_COUNTS}"; fi
  exit 0
fi
if [[ "$*" == *"pg_is_in_recovery"* ]]; then
  [ -n "\${FAKE_NOT_READY:-}" ] && exit 1
  echo f; exit 0
fi
if [[ "$1" == inspect ]]; then
  [ -n "\${FAKE_CONTAINER_DEAD:-}" ] && echo false || echo true
  exit 0
fi
if [[ "$1" == logs ]]; then echo "FATAL: invalid value for parameter recovery_target_time"; exit 0; fi
exit 0`,
  );
  // curl: аргументы и stdin (конфиг с адресом и текстом) пишутся в журнал раздельно.
  fake(
    "curl",
    `echo "curl-args $*" >> "${log}"
echo "curl-stdin $(cat | tr '\\n' ' ')" >> "${log}"
exit "\${FAKE_CURL_EXIT:-0}"`,
  );
  fake(
    "df",
    `echo "Filesystem 1024-blocks Used Available Capacity Mounted on"
echo "/dev/x 100 \${FAKE_DISK_PERCENT:-10} 0 \${FAKE_DISK_PERCENT:-10}% /"`,
  );
  fake("sleep", "exit 0");

  const meminfo = join(dir, "meminfo");
  writeFileSync(meminfo, "MemTotal:        4000000 kB\nMemAvailable:    3000000 kB\n");

  return {
    dir,
    bin,
    log,
    state,
    run: (name, args = [], env = {}) =>
      spawnSync("bash", [script(name), ...args], {
        cwd: dir,
        encoding: "utf8",
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: dir,
          DEPLOY_DIR: dir,
          STATE_DIR: state,
          MEMINFO_FILE: meminfo,
          ARCHIVE_WAIT_SECONDS: "0",
          RESTORE_WAIT_ATTEMPTS: "2",
          RESTORE_WAIT_INTERVAL: "0",
          ...env,
        },
      }),
    calls: () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []),
    text: (result) => `${result.stdout}${result.stderr}`,
  };
}

const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3600_000).toISOString();
const backupList = (dir: string, hours: number | null) => {
  const file = join(dir, "backup-list.json");
  const body =
    hours === null
      ? "null"
      : JSON.stringify([
          { backup_name: "base_old", time: hoursAgo(hours + 24), finish_time: hoursAgo(hours + 24) },
          { backup_name: "base_new", time: hoursAgo(hours), finish_time: hoursAgo(hours) },
        ]);
  writeFileSync(file, body);
  return file;
};

describe("infra/backup/full-backup.sh", () => {
  let f: Fixture;
  beforeEach(() => {
    f = fixture();
  });
  afterEach(() => rmSync(f.dir, { recursive: true, force: true }));

  it("[SH-012 AC-1] делает backup-push, затем оставляет 30 полных бэкапов", () => {
    const result = f.run("full-backup.sh");
    expect(result.status, f.text(result)).toBe(0);
    const calls = f.calls();
    const push = calls.findIndex((line) => line.includes("wal-g backup-push"));
    const retain = calls.findIndex((line) => line.includes("wal-g delete retain FULL 30 --confirm"));
    expect(push).toBeGreaterThanOrEqual(0);
    expect(retain).toBeGreaterThan(push);
    expect(calls[push]).toContain("exec -T -u postgres postgres");
  });

  it("[SH-012 AC-1] число хранимых полных бэкапов задаёт BACKUP_RETAIN_FULL", () => {
    expect(f.run("full-backup.sh", [], { BACKUP_RETAIN_FULL: "7" }).status).toBe(0);
    expect(f.calls().some((line) => line.includes("delete retain FULL 7 --confirm"))).toBe(true);
  });

  it("[SH-012 AC-1] если backup-push упал, старые бэкапы не удаляются, код выхода 1, в Telegram уходит алерт", () => {
    const result = f.run("full-backup.sh", [], { FAKE_FAIL_ON: "backup-push" });
    expect(result.status).toBe(1);
    const calls = f.calls();
    expect(calls.some((line) => line.includes("delete retain"))).toBe(false);
    const stdin = calls.find((line) => line.startsWith("curl-stdin"));
    expect(stdin).toContain('url = "https://telegram.example.test/send"');
    expect(stdin).toMatch(/бэкап/iu);
  });

  it("[SH-012 AC-1] отказывается работать без данных бакета и не вызывает docker", () => {
    writeFileSync(join(f.dir, ".env.backup"), "# пусто\n");
    chmodSync(join(f.dir, ".env.backup"), 0o600);
    const result = f.run("full-backup.sh");
    expect(result.status).not.toBe(0);
    expect(f.calls().filter((line) => line.startsWith("docker"))).toEqual([]);
  });

  const pushLine = () => f.calls().find((line) => /^docker .*backup-push/.test(line)) ?? "";

  it("[SH-012 AC-1] backup-push идёт под timeout: по умолчанию 2 часа, BACKUP_TIMEOUT_HOURS меняет значение", () => {
    expect(f.run("full-backup.sh").status).toBe(0);
    expect(pushLine()).toMatch(/timeout .*backup-push.* 7200$/);
    rmSync(f.log);
    expect(f.run("full-backup.sh", [], { BACKUP_TIMEOUT_HOURS: "5" }).status).toBe(0);
    expect(pushLine()).toMatch(/timeout .*backup-push.* 18000$/);
  });

  it("[SH-012 AC-1] если backup-push не уложился во время (код 124), старые бэкапы не удаляются, код 1, алерт сразу", () => {
    const result = f.run("full-backup.sh", [], { FAKE_TIMEOUT_ON: "backup-push", BACKUP_TIMEOUT_HOURS: "3" });
    expect(result.status).toBe(1);
    const calls = f.calls();
    expect(calls.some((line) => line.includes("delete retain"))).toBe(false);
    const stdin = calls.find((line) => line.startsWith("curl-stdin"));
    expect(stdin).toMatch(/бэкап/iu);
    expect(stdin).toMatch(/3 ч/u);
    expect(f.text(result)).toMatch(/не уложился/u);
  });

  it("[SH-012 AC-1] BACKUP_TIMEOUT_HOURS не число: отказ до вызова docker", () => {
    for (const bad of ["abc", "0", "-1", "1.5"]) {
      rmSync(f.log, { force: true });
      const result = f.run("full-backup.sh", [], { BACKUP_TIMEOUT_HOURS: bad });
      expect(result.status, bad).toBe(2);
      expect(
        f.calls().filter((line) => line.startsWith("docker")),
        bad,
      ).toEqual([]);
    }
  });

  const lastBackup = () => join(f.state, "last-backup.status");

  it("[SH-012 AC-3] после успешного backup-push пишет время успеха в last-backup.status", () => {
    const before = Math.floor(Date.now() / 1000);
    expect(f.run("full-backup.sh").status).toBe(0);
    const [kind, stamp] = readFileSync(lastBackup(), "utf8").trim().split(" ");
    expect(kind).toBe("ok");
    expect(Number(stamp)).toBeGreaterThanOrEqual(before - 1);
    expect(Number(stamp)).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 1);
  });

  it("[SH-012 AC-3] если backup-push упал или не уложился во время, прежнее время успеха не меняется", () => {
    writeFileSync(lastBackup(), "ok 1\n");
    expect(f.run("full-backup.sh", [], { FAKE_FAIL_ON: "backup-push" }).status).toBe(1);
    expect(readFileSync(lastBackup(), "utf8")).toBe("ok 1\n");
    expect(f.run("full-backup.sh", [], { FAKE_TIMEOUT_ON: "backup-push" }).status).toBe(1);
    expect(readFileSync(lastBackup(), "utf8")).toBe("ok 1\n");
  });

  it("[SH-012 AC-3] если бэкап сделан, а удаление старых упало, время успеха всё равно записано", () => {
    const result = f.run("full-backup.sh", [], { FAKE_FAIL_ON: "delete retain" });
    expect(result.status).toBe(1);
    expect(readFileSync(lastBackup(), "utf8")).toMatch(/^ok \d+/);
  });

  for (const name of REQUIRED_BACKUP_NAMES) {
    for (const mode of ["removed", "empty"] as const) {
      it(`[SH-012 AC-1] отказывается работать, если в .env.backup ${mode === "empty" ? "пусто" : "нет"} ${name}, и не вызывает docker`, () => {
        const body = BACKUP_ENV_FILE.split("\n")
          .flatMap((line) => (line.startsWith(`${name}=`) ? (mode === "empty" ? [`${name}=`] : []) : [line]))
          .join("\n");
        writeFileSync(join(f.dir, ".env.backup"), body);
        const result = f.run("full-backup.sh");
        expect(result.status).toBe(1);
        expect(result.stderr).toContain(name);
        expect(f.calls().filter((line) => line.startsWith("docker"))).toEqual([]);
      });
    }
  }
});

describe("infra/backup/compare-counts.sh", () => {
  let f: Fixture;
  beforeEach(() => {
    f = fixture();
  });
  afterEach(() => rmSync(f.dir, { recursive: true, force: true }));

  const compare = (prod: string, restored: string, env: Record<string, string> = {}) => {
    writeFileSync(join(f.dir, "prod.txt"), prod);
    writeFileSync(join(f.dir, "restored.txt"), restored);
    return f.run("compare-counts.sh", [join(f.dir, "prod.txt"), join(f.dir, "restored.txt")], env);
  };

  it("[SH-012 AC-2] одинаковое число строк проходит", () => {
    const result = compare("public.a|100\ndrizzle.m|3\n", "public.a|100\ndrizzle.m|3\n");
    expect(result.status, f.text(result)).toBe(0);
  });

  it("[SH-012 AC-2] небольшая разница из-за записей во время проверки проходит", () => {
    expect(compare("public.a|1000\n", "public.a|985\n").status).toBe(0);
    expect(compare("public.a|30\n", "public.a|27\n").status).toBe(0);
  });

  it("[SH-012 AC-2] разница больше допуска не проходит и называет таблицу", () => {
    const result = compare("public.a|1000\npublic.b|50\n", "public.a|1000\npublic.b|10\n");
    expect(result.status).toBe(1);
    expect(f.text(result)).toContain("public.b");
  });

  it("[SH-012 AC-2] пустая таблица в копии при непустой на prod не проходит", () => {
    expect(compare("public.a|20\n", "public.a|0\n").status).toBe(1);
  });

  it("[SH-012 AC-2] таблица, которой нет в копии, не проходит", () => {
    const result = compare("public.a|5\npublic.b|5\n", "public.a|5\n");
    expect(result.status).toBe(1);
    expect(f.text(result)).toContain("public.b");
  });

  it("[SH-012 AC-2] пустой список таблиц не проходит: сверять нечего", () => {
    expect(compare("", "").status).toBe(1);
  });
});

describe("infra/backup/restore-check.sh", () => {
  let f: Fixture;
  beforeEach(() => {
    f = fixture();
    writeFileSync(join(f.dir, "prod.txt"), "public.a|100\ndrizzle.m|3\n");
    writeFileSync(join(f.dir, "restored.txt"), "public.a|100\ndrizzle.m|3\n");
  });
  afterEach(() => rmSync(f.dir, { recursive: true, force: true }));

  const check = (env: Record<string, string> = {}, args: string[] = []) =>
    f.run("restore-check.sh", args, {
      FAKE_PROD_COUNTS: join(f.dir, "prod.txt"),
      FAKE_RESTORED_COUNTS: join(f.dir, "restored.txt"),
      ...env,
    });
  const status = () => readFileSync(join(f.state, "restore-check.status"), "utf8").trim();

  it("[SH-012 AC-2] поднимает копию во временном контейнере, сверяет строки и пишет статус ok", () => {
    const result = check();
    expect(result.status, f.text(result)).toBe(0);
    const calls = f.calls();
    const at = (pattern: RegExp) => calls.findIndex((line) => pattern.test(line));
    const volume = at(/^docker volume create /);
    const fetch = at(/^docker run .*restore-fetch\.sh/);
    const start = at(/^docker run -d /);
    const restoredCount = calls.findIndex(
      (line, i) => i > start && /query_to_xml/.test(line) && !/^docker compose/.test(line),
    );
    expect(volume).toBeGreaterThanOrEqual(0);
    expect(fetch).toBeGreaterThan(volume);
    expect(start).toBeGreaterThan(fetch);
    expect(restoredCount).toBeGreaterThan(start);
    expect(status()).toMatch(/^ok \d+/);
  });

  it("[SH-012 AC-2] перед проверкой переключает WAL на prod, чтобы копия догнала текущее состояние", () => {
    expect(check().status).toBe(0);
    const calls = f.calls();
    const switchAt = calls.findIndex((line) => line.includes("pg_switch_wal"));
    const fetch = calls.findIndex((line) => /^docker run .*restore-fetch\.sh/.test(line));
    expect(switchAt).toBeGreaterThanOrEqual(0);
    expect(fetch).toBeGreaterThan(switchAt);
  });

  it("[SH-012 AC-2] контейнеры восстановления получают корневые сертификаты хоста, иначе wal-g не проходит TLS", () => {
    expect(check({ CA_BUNDLE: "/host/ca.crt" }).status).toBe(0);
    const runs = f.calls().filter((line) => /^docker run /.test(line));
    expect(runs.length).toBe(2);
    for (const line of runs) {
      expect(line).toContain("-v /host/ca.crt:/etc/ssl/certs/ca-certificates.crt:ro");
      expect(line).toContain("-e SSL_CERT_FILE=/etc/ssl/certs/ca-certificates.crt");
    }
  });

  it("[SH-012 AC-2] копия не публикует порты и не получает пароль приложения", () => {
    expect(check().status).toBe(0);
    const runs = f.calls().filter((line) => /^docker run /.test(line));
    expect(runs.length).toBeGreaterThan(0);
    for (const line of runs) {
      expect(line).not.toMatch(/ -p |--publish/);
      for (const secret of SECRETS) expect(line, "секрет в аргументах docker").not.toContain(secret);
    }
  });

  it("[SH-012 AC-2] после проверки удаляет контейнер и том, и когда проверка прошла, и когда нет", () => {
    expect(check().status).toBe(0);
    expect(f.calls().some((line) => /^docker rm -f /.test(line))).toBe(true);
    expect(f.calls().some((line) => /^docker volume rm /.test(line))).toBe(true);
    rmSync(f.log);
    writeFileSync(join(f.dir, "restored.txt"), "public.a|1\ndrizzle.m|3\n");
    expect(check().status).toBe(1);
    expect(f.calls().some((line) => /^docker rm -f /.test(line))).toBe(true);
    expect(f.calls().some((line) => /^docker volume rm /.test(line))).toBe(true);
  });

  it("[SH-012 AC-2, AC-3] расхождение строк: код 1, статус fail, алерт в Telegram", () => {
    writeFileSync(join(f.dir, "restored.txt"), "public.a|1\ndrizzle.m|3\n");
    const result = check();
    expect(result.status).toBe(1);
    expect(status()).toMatch(/^fail \d+/);
    const stdin = f.calls().find((line) => line.startsWith("curl-stdin"));
    expect(stdin).toMatch(/восстановлен/iu);
  });

  it("[SH-012 AC-2, AC-3] если восстановление из бэкапа упало, статус fail и алерт", () => {
    const result = check({ FAKE_FAIL_ON: "restore-fetch.sh" });
    expect(result.status).toBe(1);
    expect(status()).toMatch(/^fail \d+/);
    expect(f.calls().some((line) => line.startsWith("curl-stdin"))).toBe(true);
  });

  it("[SH-012 AC-5] с --target-time копия восстанавливается на момент времени и сверка строк не выполняется", () => {
    writeFileSync(join(f.dir, "restored.txt"), "public.a|1\ndrizzle.m|3\n");
    const result = check({}, ["--target-time", "2026-11-14T10:00:00Z"]);
    expect(result.status, f.text(result)).toBe(0);
    const fetch = f.calls().find((line) => /^docker run .*restore-fetch\.sh/.test(line));
    expect(fetch).toContain("RESTORE_TARGET_TIME");
    expect(f.text(result)).toContain("public.a|1");
    // Проверка на момент времени не меняет статус еженедельной проверки.
    expect(existsSync(join(f.state, "restore-check.status"))).toBe(false);
  });

  it("[SH-012 AC-2] если контейнер копии остановился, скрипт сразу падает с логом контейнера, а не ждёт все попытки", () => {
    const result = check({ FAKE_NOT_READY: "1", FAKE_CONTAINER_DEAD: "1", RESTORE_WAIT_ATTEMPTS: "50" });
    expect(result.status).toBe(1);
    const calls = f.calls();
    expect(calls.filter((line) => /^docker inspect /.test(line)).length).toBe(1);
    expect(calls.some((line) => /^docker logs /.test(line))).toBe(true);
    expect(f.text(result)).toContain("FATAL: invalid value for parameter recovery_target_time");
    expect(f.text(result)).toMatch(/остановился/u);
    expect(status()).toMatch(/^fail \d+/);
    expect(calls.some((line) => line.startsWith("curl-stdin"))).toBe(true);
  });

  it("[SH-012 AC-2] если копия жива, но не вышла из восстановления за все попытки, статус fail", () => {
    const result = check({ FAKE_NOT_READY: "1", RESTORE_WAIT_ATTEMPTS: "3" });
    expect(result.status).toBe(1);
    expect(f.calls().filter((line) => /^docker inspect /.test(line)).length).toBe(3);
    expect(f.text(result)).toMatch(/вовремя/u);
    expect(status()).toMatch(/^fail \d+/);
  });

  it("[SH-012 AC-5] провал --target-time не затирает статус еженедельной проверки", () => {
    writeFileSync(join(f.state, "restore-check.status"), "ok 1\n");
    const result = check({ FAKE_NOT_READY: "1", FAKE_CONTAINER_DEAD: "1" }, ["--target-time", "2026-11-14T10:00:00Z"]);
    expect(result.status).toBe(1);
    expect(status()).toBe("ok 1");
    expect(f.calls().some((line) => line.startsWith("curl-stdin"))).toBe(false);
  });

  it("[SH-012 AC-5] --target-time принимает только UTC в формате YYYY-MM-DDTHH:MM:SSZ", () => {
    for (const bad of ["2026-11-14 12:48:09+00", "2026-11-14", "12:48"]) {
      const result = check({}, ["--target-time", bad]);
      expect(result.status, bad).toBe(2);
    }
    expect(f.calls()).toEqual([]);
  });
});

// restore-fetch.sh работает внутри контейнера postgres; здесь gosu, install и wal-g подменены.
describe("infra/backup/restore-fetch.sh", () => {
  let f: Fixture;
  beforeEach(() => {
    f = fixture();
    const fake = (name: string, body: string) => {
      writeFileSync(join(f.bin, name), `#!/usr/bin/env bash\n${body}\n`);
      chmodSync(join(f.bin, name), 0o755);
    };
    fake("gosu", 'shift\nexec "$@"');
    fake("install", 'mkdir -p "${@: -1}"');
    fake(
      "wal-g",
      `echo "wal-g $*" >> "${f.log}"
if [ "$1" = backup-list ]; then
  echo "name modified wal_segment_backup_start"
  echo "base_early 2026-11-14T08:00:00Z 000000010000000000000003"
  echo "base_late 2026-11-14T12:00:00Z 000000010000000000000009"
fi`,
    );
  });
  afterEach(() => rmSync(f.dir, { recursive: true, force: true }));

  const pgdata = () => join(f.dir, "pgdata");
  const fetch = (env: Record<string, string> = {}) =>
    f.run("restore-fetch.sh", [], { WALG_BIN: join(f.bin, "wal-g"), PGDATA: pgdata(), ...env });
  const conf = () => readFileSync(join(pgdata(), "postgresql.auto.conf"), "utf8");

  it("[SH-012 AC-5] записывает recovery_target_time в формате Postgres: пробел вместо T и +00 вместо Z", () => {
    const result = fetch({ RESTORE_TARGET_TIME: "2026-11-14T12:48:09Z" });
    expect(result.status, f.text(result)).toBe(0);
    expect(conf()).toContain("recovery_target_time = '2026-11-14 12:48:09+00'");
    expect(conf()).not.toMatch(/recovery_target_time = '[^']*[TZ]/);
    expect(conf()).toContain("recovery_target_action = 'promote'");
    expect(existsSync(join(pgdata(), "recovery.signal"))).toBe(true);
  });

  it("[SH-012 AC-5] берёт последний бэкап не позже выбранного момента", () => {
    expect(fetch({ RESTORE_TARGET_TIME: "2026-11-14T12:48:09Z" }).status).toBe(0);
    expect(f.calls().some((line) => line.endsWith("backup-fetch " + pgdata() + " base_late"))).toBe(true);
    rmSync(f.log);
    expect(fetch({ RESTORE_TARGET_TIME: "2026-11-14T10:00:00Z" }).status).toBe(0);
    expect(f.calls().some((line) => line.endsWith("backup-fetch " + pgdata() + " base_early"))).toBe(true);
  });

  it("[SH-012 AC-5] отказывает, если до выбранного момента бэкапа нет", () => {
    const result = fetch({ RESTORE_TARGET_TIME: "2026-11-14T07:00:00Z" });
    expect(result.status).toBe(1);
    expect(f.calls().some((line) => line.includes("backup-fetch"))).toBe(false);
  });

  it("[SH-012 AC-5] отказывает на времени не в формате UTC с T и Z", () => {
    const result = fetch({ RESTORE_TARGET_TIME: "2026-11-14 12:48:09+00" });
    expect(result.status).toBe(2);
    expect(f.calls()).toEqual([]);
  });

  it("[SH-012 AC-2] без времени не пишет recovery_target_time и берёт LATEST", () => {
    const result = fetch();
    expect(result.status, f.text(result)).toBe(0);
    expect(conf()).not.toContain("recovery_target_time");
    expect(f.calls().some((line) => line.endsWith("backup-fetch " + pgdata() + " LATEST"))).toBe(true);
  });
});

describe("infra/backup/alerts.sh", () => {
  let f: Fixture;
  beforeEach(() => {
    f = fixture();
  });
  afterEach(() => rmSync(f.dir, { recursive: true, force: true }));

  // Время последнего успешного бэкапа пишет full-backup.sh; здесь оно задаётся файлом, запрос в хранилище не нужен.
  const writeBackup = (hours: number) =>
    writeFileSync(join(f.state, "last-backup.status"), `ok ${Math.floor((Date.now() - hours * 3600_000) / 1000)}\n`);
  const healthy = () => {
    writeBackup(3);
    return {};
  };
  const writeStatus = (kind: "ok" | "fail", hours: number) =>
    writeFileSync(
      join(f.state, "restore-check.status"),
      `${kind} ${Math.floor((Date.now() - hours * 3600_000) / 1000)}\n`,
    );
  const sent = () => f.calls().filter((line) => line.startsWith("curl-stdin"));
  const listCalls = () => f.calls().filter((line) => line.includes("backup-list"));

  it("[SH-012 AC-3] если всё в порядке, сообщений нет", () => {
    writeStatus("ok", 24);
    const result = f.run("alerts.sh", [], healthy());
    expect(result.status, f.text(result)).toBe(0);
    expect(sent()).toEqual([]);
  });

  it("[SH-012 AC-3] последнему бэкапу больше 26 часов: алерт", () => {
    writeStatus("ok", 24);
    writeBackup(27);
    const result = f.run("alerts.sh");
    expect(result.status).toBe(0);
    expect(sent().length).toBe(1);
    expect(sent()[0]).toMatch(/бэкап/iu);
    expect(sent()[0]).toContain("27 ч");
  });

  it("[SH-012 AC-3] последнему бэкапу 25 часов: алерта нет", () => {
    writeStatus("ok", 24);
    writeBackup(25);
    f.run("alerts.sh");
    expect(sent()).toEqual([]);
  });

  it("[SH-012 AC-3] порог возраста бэкапа задаёт BACKUP_MAX_AGE_HOURS", () => {
    writeStatus("ok", 24);
    writeBackup(5);
    f.run("alerts.sh", [], { BACKUP_MAX_AGE_HOURS: "4" });
    expect(sent().length).toBe(1);
  });

  it("[SH-012 AC-3] возраст бэкапа берётся из last-backup.status: хранилище не опрашивается", () => {
    writeStatus("ok", 24);
    writeBackup(3);
    f.run("alerts.sh");
    f.run("alerts.sh");
    expect(listCalls()).toEqual([]);
  });

  it("[SH-012 AC-3] нет last-backup.status: один запрос списка бэкапов, свежий бэкап не даёт алерта и запоминается", () => {
    writeStatus("ok", 24);
    const list = backupList(f.dir, 3);
    f.run("alerts.sh", [], { FAKE_BACKUP_LIST: list });
    expect(listCalls().length).toBe(1);
    expect(sent()).toEqual([]);
    expect(readFileSync(join(f.state, "last-backup.status"), "utf8")).toMatch(/^ok \d+/);
    f.run("alerts.sh", [], { FAKE_BACKUP_LIST: list });
    expect(listCalls().length).toBe(1);
  });

  it("[SH-012 AC-3] нет last-backup.status и в хранилище бэкап старше 26 часов: алерт", () => {
    writeStatus("ok", 24);
    f.run("alerts.sh", [], { FAKE_BACKUP_LIST: backupList(f.dir, 27) });
    expect(sent().length).toBe(1);
    expect(sent()[0]).toMatch(/бэкап/iu);
  });

  it("[SH-012 AC-3] нет last-backup.status и бэкапов в хранилище нет или список не получен: алерт", () => {
    writeStatus("ok", 24);
    f.run("alerts.sh", [], { FAKE_BACKUP_LIST: backupList(f.dir, null) });
    expect(sent().length).toBe(1);
    expect(existsSync(join(f.state, "last-backup.status"))).toBe(false);
    rmSync(join(f.state, "alerts"), { recursive: true, force: true });
    rmSync(f.log);
    f.run("alerts.sh", [], { FAKE_BACKUP_LIST: backupList(f.dir, 3), FAKE_LIST_EXIT: "1" });
    expect(sent().length).toBe(1);
  });

  it("[SH-012 AC-3] проверка восстановления упала: алерт", () => {
    writeStatus("fail", 2);
    f.run("alerts.sh", [], healthy());
    expect(sent().length).toBe(1);
    expect(sent()[0]).toMatch(/восстановлен/iu);
  });

  it("[SH-012 AC-3] проверка восстановления не запускалась больше 8 суток или ни разу: алерт", () => {
    writeStatus("ok", 24 * 9);
    f.run("alerts.sh", [], healthy());
    expect(sent().length).toBe(1);
    rmSync(join(f.state, "restore-check.status"));
    rmSync(join(f.state, "alerts"), { recursive: true, force: true });
    rmSync(f.log);
    f.run("alerts.sh", [], healthy());
    expect(sent().length).toBe(1);
  });

  it("[SH-012 AC-3] диск заполнен больше чем на 80%: алерт, на 80% и меньше: нет", () => {
    writeStatus("ok", 24);
    f.run("alerts.sh", [], { ...healthy(), FAKE_DISK_PERCENT: "80" });
    expect(sent()).toEqual([]);
    f.run("alerts.sh", [], { ...healthy(), FAKE_DISK_PERCENT: "81" });
    expect(sent().length).toBe(1);
    expect(sent()[0]).toMatch(/диск/iu);
    expect(sent()[0]).toContain("81");
  });

  it("[SH-012 AC-3] мало памяти: алерт", () => {
    writeStatus("ok", 24);
    writeFileSync(join(f.dir, "meminfo"), "MemTotal:        4000000 kB\nMemAvailable:     200000 kB\n");
    f.run("alerts.sh", [], { ...healthy(), MEMINFO_FILE: join(f.dir, "meminfo") });
    expect(sent().length).toBe(1);
    expect(sent()[0]).toMatch(/памят/iu);
  });

  it("[SH-012 AC-3] один и тот же алерт повторяется не чаще, чем раз в ALERT_REPEAT_HOURS", () => {
    writeStatus("ok", 24);
    const env = { ...healthy(), FAKE_DISK_PERCENT: "95" };
    f.run("alerts.sh", [], env);
    f.run("alerts.sh", [], env);
    expect(sent().length).toBe(1);
    f.run("alerts.sh", [], { ...env, ALERT_REPEAT_HOURS: "0" });
    expect(sent().length).toBe(2);
  });

  it("[SH-012 AC-3] если Telegram не принял сообщение, код выхода 1 и повтор при следующем запуске", () => {
    writeStatus("ok", 24);
    const env = { ...healthy(), FAKE_DISK_PERCENT: "95" };
    expect(f.run("alerts.sh", [], { ...env, FAKE_CURL_EXIT: "22" }).status).toBe(1);
    expect(f.run("alerts.sh", [], env).status).toBe(0);
    expect(sent().length).toBe(2);
  });

  it("[SH-012 AC-3] алерт не содержит секретов, токен бота не попадает в аргументы curl", () => {
    writeStatus("fail", 2);
    writeFileSync(join(f.dir, "meminfo"), "MemTotal:        4000000 kB\nMemAvailable:     100000 kB\n");
    writeBackup(30);
    f.run("alerts.sh", [], {
      FAKE_DISK_PERCENT: "95",
      MEMINFO_FILE: join(f.dir, "meminfo"),
      FAKE_ARCHIVER: "1|7200",
    });
    const calls = f.calls();
    expect(sent().length).toBe(5);
    for (const line of calls) {
      for (const secret of SECRETS) expect(line).not.toContain(secret);
    }
    for (const line of calls.filter((entry) => entry.startsWith("curl-args"))) {
      expect(line).not.toContain(TOKEN);
    }
  });

  // Архивация WAL: alerts.sh спрашивает pg_stat_archiver у Postgres. Ответ фальшивого docker: «<сбой 0|1>|<секунд с последнего успеха, -1 если успехов не было>».
  const archiverCalls = () => f.calls().filter((line) => line.includes("pg_stat_archiver"));

  it("[SH-012 AC-3] архивация WAL здорова: запрос к pg_stat_archiver идёт в контейнер postgres, алерта нет", () => {
    writeStatus("ok", 24);
    const result = f.run("alerts.sh", [], { ...healthy(), FAKE_ARCHIVER: "0|120" });
    expect(result.status, f.text(result)).toBe(0);
    expect(archiverCalls().length).toBe(1);
    expect(archiverCalls()[0]).toMatch(/^docker compose .* exec -T .*postgres /);
    expect(sent()).toEqual([]);
  });

  it("[SH-012 AC-3] последняя отправка WAL упала позже успешной и успеха нет дольше 30 минут: алерт", () => {
    writeStatus("ok", 24);
    const result = f.run("alerts.sh", [], { ...healthy(), FAKE_ARCHIVER: "1|2400" });
    expect(result.status).toBe(0);
    expect(sent().length).toBe(1);
    expect(sent()[0]).toMatch(/архивац/iu);
    expect(sent()[0]).toMatch(/WAL/);
    expect(sent()[0]).toContain("40 мин");
  });

  it("[SH-012 AC-3] сбой архивации моложе порога (10 минут): алерта нет, порог задаёт ARCHIVE_FAIL_MINUTES", () => {
    writeStatus("ok", 24);
    f.run("alerts.sh", [], { ...healthy(), FAKE_ARCHIVER: "1|600" });
    expect(sent()).toEqual([]);
    f.run("alerts.sh", [], { ...healthy(), FAKE_ARCHIVER: "1|600", ARCHIVE_FAIL_MINUTES: "5" });
    expect(sent().length).toBe(1);
  });

  it("[SH-012 AC-3] старый успех без новых сбоев (тихая база) не даёт алерта", () => {
    writeStatus("ok", 24);
    f.run("alerts.sh", [], { ...healthy(), FAKE_ARCHIVER: "0|86400" });
    expect(sent()).toEqual([]);
  });

  it("[SH-012 AC-3] сбои есть, успехов ещё не было: алерт", () => {
    writeStatus("ok", 24);
    f.run("alerts.sh", [], { ...healthy(), FAKE_ARCHIVER: "1|-1" });
    expect(sent().length).toBe(1);
    expect(sent()[0]).toMatch(/архивац/iu);
  });

  it("[SH-012 AC-3] не удалось спросить Postgres об архивации: алерт", () => {
    writeStatus("ok", 24);
    f.run("alerts.sh", [], { ...healthy(), FAKE_ARCHIVER_EXIT: "1" });
    expect(sent().length).toBe(1);
    expect(sent()[0]).toMatch(/архивац/iu);
  });

  it("[SH-012 AC-3] алерт об архивации повторяется не чаще ALERT_REPEAT_HOURS, а после восстановления следующий сбой уходит сразу", () => {
    writeStatus("ok", 24);
    const failing = { ...healthy(), FAKE_ARCHIVER: "1|2400" };
    f.run("alerts.sh", [], failing);
    f.run("alerts.sh", [], failing);
    expect(sent().length).toBe(1);
    f.run("alerts.sh", [], { ...healthy(), FAKE_ARCHIVER: "0|60" });
    f.run("alerts.sh", [], failing);
    expect(sent().length).toBe(2);
  });

  it("[SH-012 AC-3] --test отправляет тестовое сообщение и сообщает, если Telegram недоступен", () => {
    const ok = f.run("alerts.sh", ["--test"]);
    expect(ok.status, f.text(ok)).toBe(0);
    expect(sent().length).toBe(1);
    const failed = f.run("alerts.sh", ["--test"], { FAKE_CURL_EXIT: "28" });
    expect(failed.status).toBe(1);
    expect(f.text(failed)).toMatch(/Telegram/);
  });
});

describe("прокси Telegram: notify и Cloudflare Worker", () => {
  const PROXY = "https://proxy.example.test";
  let f: Fixture;
  beforeEach(() => {
    f = fixture();
  });
  afterEach(() => rmSync(f.dir, { recursive: true, force: true }));

  // Переписывает .env.telegram: настройки Telegram лежат только в нём, .env.backup их не содержит.
  const setTelegramEnv = (lines: string[]) => writeFileSync(join(f.dir, ".env.telegram"), `${lines.join("\n")}\n`);
  const stdin = () => f.calls().find((line) => line.startsWith("curl-stdin")) ?? "";

  it("[SH-012 AC-3] с TELEGRAM_API_URL запрос идёт на $TELEGRAM_API_URL/send, секрет прокси уходит заголовком через stdin", () => {
    setTelegramEnv([`TELEGRAM_API_URL=${PROXY}`, "TELEGRAM_PROXY_SECRET=PROXY-SHARED-SECRET"]);
    const result = f.run("alerts.sh", ["--test"]);
    expect(result.status, f.text(result)).toBe(0);
    expect(stdin()).toContain(`url = "${PROXY}/send"`);
    expect(stdin()).toContain('header = "X-Proxy-Secret: PROXY-SHARED-SECRET"');
    for (const line of f.calls().filter((entry) => entry.startsWith("curl-args"))) {
      expect(line).not.toContain("PROXY-SHARED-SECRET");
    }
  });

  it("[SH-012 AC-3] в режиме прокси токен бота не нужен и не используется, даже если он есть в .env.telegram", () => {
    setTelegramEnv([
      `TELEGRAM_API_URL=${PROXY}`,
      "TELEGRAM_PROXY_SECRET=PROXY-SHARED-SECRET",
      "TELEGRAM_CHAT_ID=42",
      `TELEGRAM_BOT_TOKEN=${TOKEN}`,
    ]);
    const result = f.run("alerts.sh", ["--test"]);
    expect(result.status, f.text(result)).toBe(0);
    expect(f.calls().join("\n")).not.toContain(TOKEN);
    expect(stdin()).not.toContain("/bot");
  });

  it("[SH-012 AC-3] в режиме прокси chat id не передаётся, даже если он задан: его хранит Worker", () => {
    setTelegramEnv([`TELEGRAM_API_URL=${PROXY}`, "TELEGRAM_PROXY_SECRET=PROXY-SHARED-SECRET", "TELEGRAM_CHAT_ID=42"]);
    const result = f.run("alerts.sh", ["--test"]);
    expect(result.status, f.text(result)).toBe(0);
    expect(stdin()).not.toContain("chat_id");
    expect(stdin()).toContain("text=");
  });

  it("[SH-012 AC-3] TELEGRAM_API_URL без TELEGRAM_PROXY_SECRET: отказ без запроса", () => {
    setTelegramEnv([`TELEGRAM_API_URL=${PROXY}`, "TELEGRAM_PROXY_SECRET="]);
    const result = f.run("alerts.sh", ["--test"]);
    expect(result.status).toBe(1);
    expect(f.calls().some((line) => line.startsWith("curl"))).toBe(false);
    expect(f.text(result)).toContain("TELEGRAM_PROXY_SECRET");
  });

  it("[SH-012 AC-3] без прокси запрос идёт на api.telegram.org с токеном через stdin и без заголовка с секретом", () => {
    setTelegramEnv([
      "TELEGRAM_API_URL=",
      "TELEGRAM_PROXY_SECRET=",
      "TELEGRAM_CHAT_ID=42",
      `TELEGRAM_BOT_TOKEN=${TOKEN}`,
    ]);
    const result = f.run("alerts.sh", ["--test"]);
    expect(result.status, f.text(result)).toBe(0);
    expect(stdin()).toContain(`url = "https://api.telegram.org/bot${TOKEN}/sendMessage"`);
    expect(stdin()).toContain("chat_id=42");
    expect(stdin()).not.toContain("X-Proxy-Secret");
    for (const line of f.calls().filter((entry) => entry.startsWith("curl-args"))) {
      expect(line).not.toContain(TOKEN);
    }
  });

  it("[SH-012 AC-3] без прокси и без токена бота: отказ без запроса", () => {
    setTelegramEnv(["TELEGRAM_API_URL=", "TELEGRAM_CHAT_ID=42"]);
    const result = f.run("alerts.sh", ["--test"]);
    expect(result.status).toBe(1);
    expect(f.calls().some((line) => line.startsWith("curl"))).toBe(false);
  });

  it("[SH-012 AC-3] настройки Telegram читаются только из .env.telegram: значения в .env.backup игнорируются", () => {
    rmSync(join(f.dir, ".env.telegram"));
    writeFileSync(
      join(f.dir, ".env.backup"),
      `${BACKUP_ENV_FILE}TELEGRAM_API_URL=${PROXY}\nTELEGRAM_PROXY_SECRET=PROXY-SHARED-SECRET\n`,
    );
    const result = f.run("alerts.sh", ["--test"]);
    expect(result.status).toBe(1);
    expect(f.calls().some((line) => line.startsWith("curl"))).toBe(false);
  });

  it("[SH-012 AC-3] без файла .env.telegram бэкап не падает из-за алерта: full-backup.sh проходит, алерт не уходит", () => {
    rmSync(join(f.dir, ".env.telegram"));
    expect(f.run("full-backup.sh").status).toBe(0);
    expect(f.calls().some((line) => line.startsWith("curl"))).toBe(false);
  });

  describe("install.sh и шаблон", () => {
    const TELEGRAM_PROXY = `TELEGRAM_API_URL=${PROXY}\nTELEGRAM_PROXY_SECRET=s\n`;

    it("[SH-012 AC-3] в режиме прокси install.sh не требует ни TELEGRAM_BOT_TOKEN, ни TELEGRAM_CHAT_ID", () => {
      installCheck({ telegram: TELEGRAM_PROXY }, ({ result }) => {
        expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
      });
    });

    it("[SH-012 AC-3] в режиме прокси install.sh требует TELEGRAM_PROXY_SECRET", () => {
      installCheck({ telegram: `TELEGRAM_API_URL=${PROXY}\nTELEGRAM_PROXY_SECRET=\n` }, ({ result }) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("В .env.telegram не заданы");
        expect(result.stderr).toContain("TELEGRAM_PROXY_SECRET");
      });
    });

    it("[SH-012 AC-3] без прокси install.sh требует TELEGRAM_BOT_TOKEN и TELEGRAM_CHAT_ID", () => {
      installCheck({ telegram: "TELEGRAM_API_URL=\n" }, ({ result }) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("TELEGRAM_BOT_TOKEN");
        expect(result.stderr).toContain("TELEGRAM_CHAT_ID");
      });
    });

    it("[SH-012 AC-3] install.sh отказывается работать без файла .env.telegram и с правами шире 600", () => {
      installCheck({ telegram: null }, ({ result }) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(".env.telegram");
      });
      installCheck({ telegramMode: 0o644 }, ({ result }) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain(".env.telegram");
        expect(result.stderr).toContain("600");
      });
    });

    it("[SH-012 AC-1] install.sh отказывается работать, если в .env.backup остались TELEGRAM_* или другие лишние переменные (их получит postgres)", () => {
      for (const extra of ["TELEGRAM_CHAT_ID=42", "TELEGRAM_PROXY_SECRET=SECRET-PROXY", "DOMAIN=example.test"]) {
        installCheck(
          { backup: `${BACKUP_ENV_FILE.replace("SECRET-ENC-KEY", "a".repeat(64))}${extra}\n` },
          ({ result }) => {
            const name = extra.split("=")[0] ?? "";
            expect(result.status, extra).not.toBe(0);
            expect(result.stderr, extra).toContain(".env.backup");
            expect(result.stderr, extra).toContain(name);
            expect(result.stderr, extra).toContain(".env.telegram");
            expect(result.stderr, extra).not.toContain("SECRET-PROXY");
          },
        );
      }
    });

    it("[SH-012 AC-3] install.sh отказывается работать, если TELEGRAM_* остались в .env (его читает app)", () => {
      installCheck({ env: `${ENV_FILE}TELEGRAM_BOT_TOKEN=${TOKEN}\n` }, ({ result }) => {
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain("TELEGRAM_BOT_TOKEN");
        expect(result.stderr).not.toContain(TOKEN);
      });
    });

    it("[SH-012 AC-3] шаблон .env.telegram.example описывает прокси и прямой режим", () => {
      const example = read("infra/.env.telegram.example");
      expect(example).toMatch(/^TELEGRAM_API_URL=$/m);
      expect(example).toMatch(/^TELEGRAM_PROXY_SECRET=$/m);
    });
  });

  describe("infra/telegram-proxy/worker.js", () => {
    type Worker = { fetch: (request: Request, env: Record<string, string | undefined>) => Promise<Response> };
    const SECRET = "PROXY-SHARED-SECRET";
    const BOT_TOKEN = "123456:ABC-def_1";
    const SEND = "https://proxy.example.test/send";
    const baseEnv = { PROXY_SECRET: SECRET, TELEGRAM_BOT_TOKEN: BOT_TOKEN, TELEGRAM_CHAT_ID: "42" };
    const realFetch = globalThis.fetch;
    let upstream: { url: string; init: RequestInit | undefined }[];
    let worker: Worker;

    beforeEach(async () => {
      upstream = [];
      globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
        upstream.push({ url: String(url), init });
        return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } });
      }) as typeof fetch;
      const module = await import(pathToFileURL(join(repoRoot, "infra/telegram-proxy/worker.js")).href);
      worker = module.default as Worker;
    });
    afterEach(() => {
      globalThis.fetch = realFetch;
    });

    const send = (
      url: string,
      init: RequestInit & { secret?: string | null; env?: Record<string, string | undefined> } = {},
    ) => {
      const { secret = SECRET, env = baseEnv, ...rest } = init;
      const headers = new Headers(rest.headers);
      if (secret !== null) headers.set("x-proxy-secret", secret);
      return worker.fetch(new Request(url, { method: "POST", body: "chat_id=42&text=hi", ...rest, headers }), env);
    };
    const upstreamBody = () => JSON.parse(String(upstream[0]?.init?.body)) as Record<string, unknown>;

    it("[SH-012 AC-3] POST /send с верным секретом пересылается на sendMessage с токеном из окружения, ответ Telegram возвращается как есть", async () => {
      const response = await send(SEND, { headers: { "content-type": "application/x-www-form-urlencoded" } });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('{"ok":true}');
      expect(upstream).toHaveLength(1);
      expect(upstream[0]?.url).toBe(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`);
      expect(upstream[0]?.init?.method).toBe("POST");
      expect(upstreamBody()).toEqual({ chat_id: "42", text: "hi" });
      expect(new Headers(upstream[0]?.init?.headers).has("x-proxy-secret")).toBe(false);
    });

    it("[SH-012 AC-3] тело в JSON тоже принимается, лишние поля не пересылаются", async () => {
      const response = await send(SEND, {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: 42, text: "hi", parse_mode: "HTML", disable_notification: true }),
      });
      expect(response.status).toBe(200);
      expect(upstreamBody()).toEqual({ chat_id: "42", text: "hi" });
    });

    it("[SH-012 AC-3] ответ ошибки Telegram возвращается с тем же кодом и телом", async () => {
      globalThis.fetch = (async () =>
        new Response('{"ok":false,"description":"chat not found"}', {
          status: 400,
          headers: { "content-type": "application/json" },
        })) as typeof fetch;
      const response = await send(SEND);
      expect(response.status).toBe(400);
      expect(await response.text()).toBe('{"ok":false,"description":"chat not found"}');
    });

    it("[SH-012 AC-3] без секрета или с неверным секретом ответ 403 и запрос в Telegram не уходит", async () => {
      expect((await send(SEND, { secret: null })).status).toBe(403);
      expect((await send(SEND, { secret: "wrong" })).status).toBe(403);
      expect((await send(SEND, { secret: "" })).status).toBe(403);
      expect(upstream).toEqual([]);
    });

    it("[SH-012 AC-3] если секрет Worker не задан, ответ 500 и запрос в Telegram не уходит", async () => {
      const response = await send(SEND, { secret: "", env: { TELEGRAM_BOT_TOKEN: BOT_TOKEN } });
      expect(response.status).toBe(500);
      expect(upstream).toEqual([]);
    });

    it("[SH-012 AC-3] если токен бота не задан в окружении Worker, ответ 500 и запрос в Telegram не уходит", async () => {
      const response = await send(SEND, { env: { PROXY_SECRET: SECRET } });
      expect(response.status).toBe(500);
      expect(upstream).toEqual([]);
    });

    it("[SH-012 AC-3] токен из пути запроса игнорируется: пути с /bot... получают 404", async () => {
      const response = await send("https://proxy.example.test/bot999:EVIL/sendMessage");
      expect(response.status).toBe(404);
      expect(upstream).toEqual([]);
    });

    it("[SH-012 AC-3] Worker не открытое реле: другие пути и методы HTTP получают 404", async () => {
      for (const url of [
        "https://proxy.example.test/send/extra",
        "https://proxy.example.test/sendMessage",
        "https://proxy.example.test/getUpdates",
        "https://proxy.example.test/",
      ]) {
        expect((await send(url)).status, url).toBe(404);
      }
      for (const method of ["GET", "PUT", "DELETE"]) {
        const response = await worker.fetch(
          new Request(SEND, { method, headers: { "x-proxy-secret": SECRET } }),
          baseEnv,
        );
        expect(response.status, method).toBe(404);
      }
      expect(upstream).toEqual([]);
    });

    it("[SH-012 AC-3] слишком большое тело отклоняется ответом 413", async () => {
      const response = await send(SEND, { body: `chat_id=42&text=${"x".repeat(10_000)}` });
      expect(response.status).toBe(413);
      expect(upstream).toEqual([]);
    });

    it("[SH-012 AC-3] без text ответ 400 и запрос в Telegram не уходит", async () => {
      expect((await send(SEND, { body: "chat_id=42" })).status).toBe(400);
      expect(upstream).toEqual([]);
    });

    it("[SH-012 AC-3] TELEGRAM_CHAT_ID в окружении Worker: запрос может не передавать chat_id, чужой chat_id отклоняется", async () => {
      const env = { ...baseEnv, TELEGRAM_CHAT_ID: "777" };
      expect((await send(SEND, { env, body: "text=hi" })).status).toBe(200);
      expect(upstreamBody()).toEqual({ chat_id: "777", text: "hi" });
      upstream.length = 0;
      expect((await send(SEND, { env, body: "chat_id=777&text=hi" })).status).toBe(200);
      expect((await send(SEND, { env, body: "chat_id=42&text=hi" })).status).toBe(403);
      expect(upstream).toHaveLength(1);
    });

    it("[SH-012 AC-3] TELEGRAM_CHAT_ID в окружении Worker обязателен: без него ответ 500, запрос в Telegram не уходит, даже если chat_id есть в теле", async () => {
      const env = { PROXY_SECRET: SECRET, TELEGRAM_BOT_TOKEN: BOT_TOKEN };
      for (const body of ["text=hi", "chat_id=42&text=hi"]) {
        const response = await send(SEND, { env, body });
        expect(response.status, body).toBe(500);
        expect(await response.text()).toBe("chat id is not configured");
      }
      expect((await send(SEND, { env: { ...env, TELEGRAM_CHAT_ID: "" }, body: "text=hi" })).status).toBe(500);
      expect(upstream).toEqual([]);
    });

    it("[SH-012 AC-3] чат всегда берётся из окружения Worker: chat_id в запросе не нужен, а чужой даёт 403", async () => {
      expect((await send(SEND, { body: "text=hi" })).status).toBe(200);
      expect(upstreamBody()).toEqual({ chat_id: "42", text: "hi" });
      expect((await send(SEND, { body: "chat_id=999&text=hi" })).status).toBe(403);
      expect(upstream).toHaveLength(1);
    });

    it("[SH-012 AC-3] Worker не пишет в лог токен и текст сообщений", async () => {
      const logged: unknown[][] = [];
      const originals = { log: console.log, info: console.info, warn: console.warn, error: console.error };
      for (const name of ["log", "info", "warn", "error"] as const)
        console[name] = (...args: unknown[]) => logged.push(args);
      try {
        await send(SEND);
        await send(SEND, { secret: "wrong" });
      } finally {
        Object.assign(console, originals);
      }
      expect(logged).toEqual([]);
      expect(read("infra/telegram-proxy/worker.js")).not.toMatch(/console\./);
    });
  });
});

describe("общий список переменных wal-g", () => {
  const scripts = ["lib.sh", "full-backup.sh", "restore-check.sh", "install.sh", "alerts.sh"];

  it("[SH-012 AC-1] шесть переменных wal-g перечислены один раз, в walg-vars.sh, а скрипты берут их оттуда", () => {
    const vars = read("infra/backup/walg-vars.sh");
    expect(vars).toMatch(/WALG_VARS=\(/);
    for (const name of REQUIRED_BACKUP_NAMES) expect(vars, name).toContain(name);
    for (const name of scripts) {
      const text = read(`infra/backup/${name}`);
      // WALG_LIBSODIUM_KEY остаётся в скриптах отдельно: проверка формата ключа и WALG_LIBSODIUM_KEY_TRANSFORM.
      for (const variable of REQUIRED_BACKUP_NAMES.filter((entry) => entry !== "WALG_LIBSODIUM_KEY")) {
        expect(text, `${name}: ${variable}`).not.toContain(variable);
      }
    }
    expect(read("infra/backup/lib.sh")).toContain("walg-vars.sh");
    expect(read("infra/backup/install.sh")).toContain("walg-vars.sh");
    expect(read("infra/backup/lib.sh")).toContain("WALG_VARS");
    expect(read("infra/backup/full-backup.sh")).toContain("WALG_VARS");
    expect(read("infra/backup/restore-check.sh")).toContain("WALG_VARS");
  });
});

describe("infra/README.md", () => {
  it("[SH-012 AC-3] описывает .env.telegram, обязательный TELEGRAM_CHAT_ID в Worker и алерт об архивации WAL", () => {
    const text = read("infra/README.md");
    expect(text).toContain(".env.telegram");
    expect(text).toMatch(/TELEGRAM_CHAT_ID[^.\n]*обязательн/iu);
    expect(text).toContain("pg_stat_archiver");
    expect(text).toContain("ARCHIVE_FAIL_MINUTES");
    expect(text).toContain("last-backup.status");
  });

  it("[SH-012 AC-3] раздел о прокси Telegram: токен хранится только в Cloudflare, адрес /send", () => {
    const text = read("infra/README.md");
    expect(text).toContain("TELEGRAM_BOT_TOKEN");
    expect(text).toContain("/send");
    expect(text).toMatch(/токен[^.]*только в Cloudflare/iu);
    expect(text).not.toContain("Токен бота виден Cloudflare");
    expect(text).toContain("BACKUP_TIMEOUT_HOURS");
  });

  it("[SH-012 AC-5] описывает восстановление на момент времени командами из infra/backup", () => {
    const text = read("infra/README.md");
    expect(text).toContain("restore-check.sh --target-time");
    expect(text).toContain("full-backup.sh");
    expect(text).toContain("WALG_LIBSODIUM_KEY");
  });
});
