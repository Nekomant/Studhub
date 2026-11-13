import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import YAML from "yaml";

// Образ и деплой (SH-011). Сам `docker build`, `docker run`, GitHub Secrets и prod проверяются вручную (план тестов задачи).
// Здесь проверяются файлы образа, шаги CI и порядок команд в infra/deploy.sh на подменённых docker и curl.

const repoRoot = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

type Step = {
  name?: string;
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, unknown>;
  env?: Record<string, string>;
};
type Job = { needs?: string | string[]; if?: string; permissions?: Record<string, string>; steps: Step[] };
type Workflow = { on: Record<string, unknown>; jobs: Record<string, Job> };
const workflow = () => YAML.parse(read(".github/workflows/ci.yml")) as Workflow;

describe("Dockerfile", () => {
  const dockerfile = () => read("Dockerfile");
  const stages = () =>
    dockerfile()
      .split(/^FROM /m)
      .slice(1);

  it("[SH-011 AC-1] Dockerfile многоэтапный: сборка и итоговый образ — разные этапы", () => {
    expect(stages().length).toBeGreaterThanOrEqual(2);
  });

  it("[SH-011 AC-1] итоговый этап запускается от непривилегированного пользователя", () => {
    const last = stages().at(-1) ?? "";
    const users = [...last.matchAll(/^USER\s+(\S+)/gm)].map((match) => match[1]);
    expect(users.length).toBeGreaterThan(0);
    expect(users.at(-1)).not.toMatch(/^(root|0)(:|$)/);
  });

  it("[SH-011 AC-1] в итоговый образ попадают только prod-зависимости и собранная SPA", () => {
    const text = dockerfile();
    expect(text).toMatch(/pnpm[^\n]*deploy[^\n]*--prod/);
    expect(text).toMatch(/pnpm[^\n]*@studhub\/web[^\n]*build/);
    const last = stages().at(-1) ?? "";
    expect(last).not.toMatch(/pnpm\s+install/);
    expect(last).toMatch(/ENV[^\n]*WEB_ROOT=/);
    expect(last).toMatch(/CMD\s+\[[^\]]*"node"/);
  });

  it("[SH-011 AC-1] в образе есть HEALTHCHECK на /healthz", () => {
    expect(dockerfile()).toMatch(/HEALTHCHECK[^\n]*\n?[^\n]*healthz/);
  });

  it("[SH-011 AC-1] app в prod-compose не опубликован наружу и больше не спрятан в профиле", () => {
    const compose = YAML.parse(read("infra/docker-compose.prod.yml")) as {
      services: Record<string, Record<string, unknown>>;
    };
    expect(compose.services.app?.profiles).toBeUndefined();
    expect(compose.services.app?.ports).toBeUndefined();
  });

  it("[SH-011 AC-1] Caddy проксирует /healthz в приложение, а не отвечает сам", () => {
    expect(read("infra/Caddyfile")).not.toMatch(/respond\s+"ok"/);
  });

  it("[SH-011 AC-1] WEB_ROOT описан в схеме конфигурации и в .env.example", () => {
    expect(read("apps/api/src/platform/config/index.ts")).toContain("WEB_ROOT");
    expect(read(".env.example")).toMatch(/^#?\s*WEB_ROOT=/m);
  });
});

describe("CI: образ и деплой", () => {
  it("[SH-011 AC-5] job image собирает образ на каждый PR и не публикует его", () => {
    const wf = workflow();
    expect(wf.on).toHaveProperty("pull_request");
    const build = wf.jobs.image?.steps.find((step) => step.uses?.startsWith("docker/build-push-action@"));
    expect(build, "нет шага docker/build-push-action").toBeDefined();
    expect(String(build?.with?.push)).toContain("github.event_name == 'push'");
    expect(wf.jobs.image?.if).toBeUndefined();
  });

  it("[SH-011 AC-2] по слиянию в main образ уходит в GHCR с тегом SHA", () => {
    const image = workflow().jobs.image;
    const login = image?.steps.find((step) => step.uses?.startsWith("docker/login-action@"));
    expect(login?.with?.registry).toBe("ghcr.io");
    expect(login?.if).toContain("github.event_name == 'push'");
    expect(image?.permissions?.packages).toBe("write");
    const build = image?.steps.find((step) => step.uses?.startsWith("docker/build-push-action@"));
    expect(String(build?.with?.tags)).toMatch(/ghcr\.io\/nekomant\/studhub:\$\{\{\s*github\.sha\s*\}\}/);
  });

  it("[SH-011 AC-2] job deploy идёт только после checks и image, только для push в main, вызывает infra/deploy.sh по SSH", () => {
    const deploy = workflow().jobs.deploy;
    expect(deploy, "нет job deploy").toBeDefined();
    expect([deploy?.needs].flat()).toEqual(expect.arrayContaining(["checks", "image"]));
    expect(deploy?.if).toContain("github.event_name == 'push'");
    expect(deploy?.if).toContain("refs/heads/main");
    const script = (deploy?.steps ?? []).map((step) => step.run ?? "").join("\n");
    expect(script).toMatch(/ssh[^\n]*deploy\.sh[^\n]*\$\{\{\s*github\.sha\s*\}\}|deploy\.sh[^\n]*\$\{?GITHUB_SHA/);
  });

  it("[SH-011 AC-4] SSH-ключ и адрес сервера берутся из GitHub Secrets, а не из репозитория", () => {
    const text = read(".github/workflows/ci.yml");
    for (const name of ["DEPLOY_SSH_KEY", "DEPLOY_HOST", "DEPLOY_USER", "DEPLOY_KNOWN_HOSTS"]) {
      expect(text).toContain(`secrets.${name}`);
    }
    expect(text).not.toMatch(/BEGIN [A-Z ]*PRIVATE KEY/);
  });
});

describe("секреты и образ", () => {
  it("[SH-011 AC-4] .dockerignore не пускает .env, git и node_modules в контекст сборки", () => {
    const ignore = read(".dockerignore")
      .split("\n")
      .map((line) => line.trim());
    expect(ignore).toEqual(expect.arrayContaining([".env", ".env.*", ".git", "node_modules"]));
  });

  it("[SH-011 AC-4] Dockerfile не получает секреты через ARG, ENV или COPY .env", () => {
    const text = read("Dockerfile");
    expect(text).not.toMatch(/^\s*ARG\s+\w*(SECRET|PASSWORD|TOKEN|KEY)/im);
    expect(text).not.toMatch(/^\s*ENV\s+\w*(SECRET|PASSWORD|TOKEN|KEY)\w*=/im);
    expect(text).not.toMatch(/COPY[^\n]*\.env/);
  });

  it("[SH-011 AC-4] шаблон .env.prod.example не содержит значений секретов", () => {
    const text = read("infra/.env.prod.example");
    for (const name of ["POSTGRES_PASSWORD", "S3_SECRET_ACCESS_KEY", "S3_ACCESS_KEY_ID"]) {
      expect(text, name).toMatch(new RegExp(`^${name}=$`, "m"));
    }
  });
});

describe("infra/deploy.sh", () => {
  let dir: string;
  let bin: string;
  let log: string;

  // Подменённые docker и curl пишут вызовы в журнал. curl падает, пока не наступит попытка FAKE_CURL_OK_AFTER.
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "deploy-"));
    bin = join(dir, "bin");
    log = join(dir, "calls.log");
    mkdirSync(bin);
    writeFileSync(join(bin, "docker"), `#!/usr/bin/env bash\necho "docker $*" >> "${log}"\n`);
    writeFileSync(
      join(bin, "curl"),
      `#!/usr/bin/env bash
echo "curl $*" >> "${log}"
n=$(grep -c '^curl ' "${log}")
[ "$n" -ge "\${FAKE_CURL_OK_AFTER:-1}" ]
`,
    );
    chmodSync(join(bin, "docker"), 0o755);
    chmodSync(join(bin, "curl"), 0o755);
    writeFileSync(join(dir, "docker-compose.prod.yml"), "name: studhub\n");
    writeFileSync(join(dir, ".env"), "DOMAIN=example.test\nPOSTGRES_PASSWORD=secret-value\nAPP_TAG=old\n");
    chmodSync(join(dir, ".env"), 0o600);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const deploy = (args: string[], env: Record<string, string> = {}) =>
    spawnSync("bash", [join(repoRoot, "infra/deploy.sh"), ...args], {
      cwd: dir,
      encoding: "utf8",
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        DEPLOY_DIR: dir,
        HEALTH_ATTEMPTS: "3",
        HEALTH_INTERVAL: "0",
        ...env,
      },
    });
  const calls = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  const indexOf = (pattern: RegExp) => calls().findIndex((line) => pattern.test(line));

  it("[SH-011 AC-2] выполняет migrate, pull, up -d и проверку /healthz именно в этом порядке", () => {
    const result = deploy(["abc123"]);
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const migrate = indexOf(/run --rm app migrate/);
    const pull = indexOf(/ pull/);
    const up = indexOf(/ up -d/);
    const health = indexOf(/^curl .*https:\/\/app\.example\.test\/healthz/);
    expect(migrate).toBeGreaterThanOrEqual(0);
    expect(pull).toBeGreaterThan(migrate);
    expect(up).toBeGreaterThan(pull);
    expect(health).toBeGreaterThan(up);
  });

  it("[SH-011 AC-2] повторяет проверку /healthz и проходит, когда приложение поднялось со 2-й попытки", () => {
    const result = deploy(["abc123"], { FAKE_CURL_OK_AFTER: "2" });
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    expect(calls().filter((line) => line.startsWith("curl ")).length).toBe(2);
  });

  it("[SH-011 AC-2] если /healthz не ответил за все попытки, скрипт завершается с кодом 1 и называет предыдущий тег", () => {
    const result = deploy(["abc123"], { FAKE_CURL_OK_AFTER: "99" });
    expect(result.status).toBe(1);
    expect(calls().filter((line) => line.startsWith("curl ")).length).toBe(3);
    expect(`${result.stdout}${result.stderr}`).toContain("old");
  });

  it("[SH-011 AC-2] если migrate упал, обновление не начинается", () => {
    writeFileSync(
      join(bin, "docker"),
      `#!/usr/bin/env bash\necho "docker $*" >> "${log}"\ncase "$*" in *migrate*) exit 1;; esac\n`,
    );
    const result = deploy(["abc123"]);
    expect(result.status).not.toBe(0);
    expect(indexOf(/run --rm app migrate/)).toBeGreaterThanOrEqual(0);
    expect(indexOf(/ up -d/)).toBe(-1);
    expect(indexOf(/ pull/)).toBe(-1);
  });

  it("[SH-011 AC-3] выкатывает указанный тег: записывает его в APP_TAG в .env и сохраняет остальное", () => {
    expect(deploy(["newtag"]).status).toBe(0);
    expect(readFileSync(join(dir, ".env"), "utf8")).toBe(
      "DOMAIN=example.test\nPOSTGRES_PASSWORD=secret-value\nAPP_TAG=newtag\n",
    );
    expect(deploy(["old"]).status).toBe(0);
    expect(readFileSync(join(dir, ".env"), "utf8")).toContain("APP_TAG=old\n");
    const stat = spawnSync(
      "bash",
      ["-c", `stat -c %a "${join(dir, ".env")}" 2>/dev/null || stat -f %Lp "${join(dir, ".env")}"`],
      { encoding: "utf8" },
    );
    expect(stat.stdout.trim()).toBe("600");
  });

  it("[SH-011 AC-3] без тега или с недопустимым тегом завершается с ошибкой и не вызывает docker", () => {
    expect(deploy([]).status).toBe(2);
    expect(deploy(["a;rm -rf /"]).status).toBe(2);
    expect(calls()).toEqual([]);
  });

  it("[SH-011 AC-4] отказывается работать, если права .env шире 600, и не печатает значения секретов", () => {
    chmodSync(join(dir, ".env"), 0o644);
    const result = deploy(["abc123"]);
    expect(result.status).not.toBe(0);
    expect(calls()).toEqual([]);
    expect(`${result.stdout}${result.stderr}`).toContain("600");
    expect(`${result.stdout}${result.stderr}`).not.toContain("secret-value");
  });
});
