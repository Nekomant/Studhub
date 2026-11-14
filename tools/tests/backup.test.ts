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
  `TELEGRAM_BOT_TOKEN=${TOKEN}`,
  "TELEGRAM_CHAT_ID=42",
  "TELEGRAM_API_URL=https://telegram.example.test",
  "",
].join("\n");

describe("compose и шаблон .env", () => {
  const postgres = () => compose().services.postgres ?? {};
  const command = () => [postgres().command].flat().join(" ");
  const environment = () => (postgres().environment ?? {}) as Record<string, string>;

  it("[SH-012 AC-1] Postgres архивирует WAL через wal-g", () => {
    expect(command()).toContain("archive_mode=on");
    expect(command()).toMatch(/archive_command=\S*wal-g wal-push %p/);
    expect(command()).toMatch(/archive_timeout=\d+/);
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

  it("[SH-012 AC-1, AC-3] шаблон .env.backup.example содержит пустые WALG_*, AWS_* и TELEGRAM_*, а .env.prod.example их не содержит", () => {
    const example = read("infra/.env.backup.example");
    for (const name of [...BACKUP_NAMES, "TELEGRAM_BOT_TOKEN", "TELEGRAM_CHAT_ID"]) {
      expect(example, name).toMatch(new RegExp(`^${name}=$`, "m"));
    }
    expect(read("infra/.env.prod.example")).not.toMatch(/^(WALG_|AWS_|TELEGRAM_)\w*=/m);
  });
});

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
    const dir = mkdtempSync(join(tmpdir(), "install-"));
    try {
      writeFileSync(join(dir, ".env"), `${ENV_FILE}AWS_ACCESS_KEY_ID=SECRET-KEY-ID\n`);
      writeFileSync(join(dir, ".env.backup"), BACKUP_ENV_FILE.replace("SECRET-ENC-KEY", "a".repeat(64)));
      chmodSync(join(dir, ".env"), 0o600);
      chmodSync(join(dir, ".env.backup"), 0o600);
      const result = spawnSync("bash", [script("install.sh")], {
        encoding: "utf8",
        env: { ...process.env, DEPLOY_DIR: dir },
      });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(".env.backup");
      expect(result.stderr).toContain("AWS_ACCESS_KEY_ID");
      expect(result.stderr).not.toContain("SECRET-KEY-ID");
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

  const fake = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  // docker: FAKE_FAIL_ON — подстрока вызова, на которой команда падает. Счёт строк берётся из файлов FAKE_PROD_COUNTS и FAKE_RESTORED_COUNTS.
  fake(
    "docker",
    `echo "docker $*" >> "${log}"
if [ -n "\${FAKE_FAIL_ON:-}" ] && [[ "$*" == *"$FAKE_FAIL_ON"* ]]; then exit 1; fi
if [[ "$*" == *"backup-list"* ]]; then
  [ -n "\${FAKE_LIST_EXIT:-}" ] && exit "$FAKE_LIST_EXIT"
  cat "\${FAKE_BACKUP_LIST:-/dev/null}"
  exit 0
fi
if [[ "$*" == *"query_to_xml"* ]]; then
  if [[ "$*" == compose* ]]; then cat "\${FAKE_PROD_COUNTS}"; else cat "\${FAKE_RESTORED_COUNTS}"; fi
  exit 0
fi
if [[ "$*" == *"pg_is_in_recovery"* ]]; then echo f; exit 0; fi
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
    expect(stdin).toContain("https://telegram.example.test/bot");
    expect(stdin).toMatch(/бэкап/iu);
  });

  it("[SH-012 AC-1] отказывается работать без данных бакета и не вызывает docker", () => {
    writeFileSync(join(f.dir, ".env.backup"), "TELEGRAM_CHAT_ID=42\n");
    chmodSync(join(f.dir, ".env.backup"), 0o600);
    const result = f.run("full-backup.sh");
    expect(result.status).not.toBe(0);
    expect(f.calls().filter((line) => line.startsWith("docker"))).toEqual([]);
  });
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
});

describe("infra/backup/alerts.sh", () => {
  let f: Fixture;
  beforeEach(() => {
    f = fixture();
  });
  afterEach(() => rmSync(f.dir, { recursive: true, force: true }));

  const healthy = () => ({
    FAKE_BACKUP_LIST: backupList(f.dir, 3),
  });
  const writeStatus = (kind: "ok" | "fail", hours: number) =>
    writeFileSync(
      join(f.state, "restore-check.status"),
      `${kind} ${Math.floor((Date.now() - hours * 3600_000) / 1000)}\n`,
    );
  const sent = () => f.calls().filter((line) => line.startsWith("curl-stdin"));

  it("[SH-012 AC-3] если всё в порядке, сообщений нет", () => {
    writeStatus("ok", 24);
    const result = f.run("alerts.sh", [], healthy());
    expect(result.status, f.text(result)).toBe(0);
    expect(sent()).toEqual([]);
  });

  it("[SH-012 AC-3] последнему бэкапу больше 26 часов: алерт", () => {
    writeStatus("ok", 24);
    const result = f.run("alerts.sh", [], { FAKE_BACKUP_LIST: backupList(f.dir, 27) });
    expect(result.status).toBe(0);
    expect(sent().length).toBe(1);
    expect(sent()[0]).toMatch(/бэкап/iu);
  });

  it("[SH-012 AC-3] последнему бэкапу 25 часов: алерта нет", () => {
    writeStatus("ok", 24);
    f.run("alerts.sh", [], { FAKE_BACKUP_LIST: backupList(f.dir, 25) });
    expect(sent()).toEqual([]);
  });

  it("[SH-012 AC-3] бэкапов нет или список не получен: алерт", () => {
    writeStatus("ok", 24);
    f.run("alerts.sh", [], { FAKE_BACKUP_LIST: backupList(f.dir, null) });
    expect(sent().length).toBe(1);
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
    f.run("alerts.sh", [], {
      FAKE_BACKUP_LIST: backupList(f.dir, 30),
      FAKE_DISK_PERCENT: "95",
      MEMINFO_FILE: join(f.dir, "meminfo"),
    });
    const calls = f.calls();
    expect(sent().length).toBe(4);
    for (const line of calls) {
      for (const secret of SECRETS) expect(line).not.toContain(secret);
    }
    for (const line of calls.filter((entry) => entry.startsWith("curl-args"))) {
      expect(line).not.toContain(TOKEN);
    }
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

  const setBackupEnv = (extra: string[]) => {
    writeFileSync(
      join(f.dir, ".env.backup"),
      `${BACKUP_ENV_FILE.replace("TELEGRAM_API_URL=https://telegram.example.test\n", "")}${extra.join("\n")}\n`,
    );
  };
  const stdin = () => f.calls().find((line) => line.startsWith("curl-stdin")) ?? "";

  it("[SH-012 AC-3] с TELEGRAM_API_URL и TELEGRAM_PROXY_SECRET запрос идёт на прокси, секрет уходит заголовком через stdin", () => {
    setBackupEnv([`TELEGRAM_API_URL=${PROXY}`, "TELEGRAM_PROXY_SECRET=PROXY-SHARED-SECRET"]);
    const result = f.run("alerts.sh", ["--test"]);
    expect(result.status, f.text(result)).toBe(0);
    expect(stdin()).toContain(`url = "${PROXY}/bot${TOKEN}/sendMessage"`);
    expect(stdin()).toContain('header = "X-Proxy-Secret: PROXY-SHARED-SECRET"');
    for (const line of f.calls().filter((entry) => entry.startsWith("curl-args"))) {
      expect(line).not.toContain("PROXY-SHARED-SECRET");
      expect(line).not.toContain(TOKEN);
    }
  });

  it("[SH-012 AC-3] без прокси запрос идёт на api.telegram.org и заголовка с секретом нет", () => {
    setBackupEnv(["TELEGRAM_API_URL=", "TELEGRAM_PROXY_SECRET="]);
    const result = f.run("alerts.sh", ["--test"]);
    expect(result.status, f.text(result)).toBe(0);
    expect(stdin()).toContain(`url = "https://api.telegram.org/bot${TOKEN}/sendMessage"`);
    expect(stdin()).not.toContain("X-Proxy-Secret");
  });

  it("[SH-012 AC-3] шаблон .env.backup.example содержит пустые TELEGRAM_API_URL и TELEGRAM_PROXY_SECRET", () => {
    const example = read("infra/.env.backup.example");
    expect(example).toMatch(/^TELEGRAM_API_URL=$/m);
    expect(example).toMatch(/^TELEGRAM_PROXY_SECRET=$/m);
  });

  describe("infra/telegram-proxy/worker.js", () => {
    type Worker = { fetch: (request: Request, env: Record<string, string | undefined>) => Promise<Response> };
    const SECRET = "PROXY-SHARED-SECRET";
    const SEND = "https://proxy.example.test/bot123456:ABC-def_1/sendMessage";
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

    const send = (url: string, init: RequestInit & { secret?: string | null } = {}) => {
      const { secret = SECRET, ...rest } = init;
      const headers = new Headers(rest.headers);
      if (secret !== null) headers.set("x-proxy-secret", secret);
      return worker.fetch(new Request(url, { method: "POST", body: "chat_id=42&text=hi", ...rest, headers }), {
        PROXY_SECRET: SECRET,
      });
    };

    it("[SH-012 AC-3] sendMessage с верным секретом пересылается на api.telegram.org, ответ Telegram возвращается", async () => {
      const response = await send(SEND, { headers: { "content-type": "application/x-www-form-urlencoded" } });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('{"ok":true}');
      expect(upstream).toHaveLength(1);
      expect(upstream[0]?.url).toBe("https://api.telegram.org/bot123456:ABC-def_1/sendMessage");
      expect(upstream[0]?.init?.method).toBe("POST");
      expect(new TextDecoder().decode(upstream[0]?.init?.body as ArrayBuffer)).toBe("chat_id=42&text=hi");
      expect(new Headers(upstream[0]?.init?.headers).has("x-proxy-secret")).toBe(false);
    });

    it("[SH-012 AC-3] без секрета или с неверным секретом ответ 403 и запрос в Telegram не уходит", async () => {
      expect((await send(SEND, { secret: null })).status).toBe(403);
      expect((await send(SEND, { secret: "wrong" })).status).toBe(403);
      expect((await send(SEND, { secret: "" })).status).toBe(403);
      expect(upstream).toEqual([]);
    });

    it("[SH-012 AC-3] если секрет Worker не задан, ответ 500 и запрос в Telegram не уходит", async () => {
      const response = await worker.fetch(new Request(SEND, { method: "POST", headers: { "x-proxy-secret": "" } }), {});
      expect(response.status).toBe(500);
      expect(upstream).toEqual([]);
    });

    it("[SH-012 AC-3] Worker не открытое реле: другие методы Telegram, пути и методы HTTP получают 404", async () => {
      for (const url of [
        "https://proxy.example.test/bot123456:ABC/getUpdates",
        "https://proxy.example.test/bot123456:ABC/sendMessage/extra",
        "https://proxy.example.test/bot123456:ABC/sendDocument",
        "https://proxy.example.test/file/bot123456:ABC/x",
        "https://proxy.example.test/",
        "https://proxy.example.test/botabc/sendMessage",
      ]) {
        expect((await send(url)).status, url).toBe(404);
      }
      const get = await worker.fetch(new Request(SEND, { headers: { "x-proxy-secret": SECRET } }), {
        PROXY_SECRET: SECRET,
      });
      expect(get.status).toBe(404);
      expect(upstream).toEqual([]);
    });

    it("[SH-012 AC-3] слишком большое тело отклоняется ответом 413", async () => {
      const response = await send(SEND, { body: "x".repeat(10_000) });
      expect(response.status).toBe(413);
      expect(upstream).toEqual([]);
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

describe("infra/README.md", () => {
  it("[SH-012 AC-5] описывает восстановление на момент времени командами из infra/backup", () => {
    const text = read("infra/README.md");
    expect(text).toContain("restore-check.sh --target-time");
    expect(text).toContain("full-backup.sh");
    expect(text).toContain("WALG_LIBSODIUM_KEY");
  });
});
