import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
// @ts-expect-error — скрипт на чистом JS без типов, проверяется через тест
import { planTestDatabaseReset } from "../../scripts/db-reset-test.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

type Compose = {
  services: Record<string, { image?: string; volumes?: string[]; depends_on?: unknown; restart?: string }>;
  volumes: Record<string, unknown>;
};

describe("локальное окружение: docker-compose.yml", () => {
  const compose = YAML.parse(read("docker-compose.yml")) as Compose;

  it("[SH-003 AC-1] postgres — образ 18 и данные в именованном томе", () => {
    const postgres = compose.services.postgres;
    expect(postgres?.image).toMatch(/^postgres:18/);
    const mount = postgres?.volumes?.find((v) => v.includes("/var/lib/postgresql"));
    expect(mount).toBeDefined();
    const volumeName = mount?.split(":")[0] ?? "";
    expect(Object.keys(compose.volumes)).toContain(volumeName);
    expect(volumeName).not.toMatch(/^[./]/);
  });

  it("[SH-003 AC-1] minio — данные в именованном томе", () => {
    const minio = compose.services.minio;
    expect(minio).toBeDefined();
    const mount = minio?.volumes?.find((v) => v.includes("/data"));
    expect(mount).toBeDefined();
    expect(Object.keys(compose.volumes)).toContain(mount?.split(":")[0] ?? "");
  });

  it("[SH-003 AC-1] одноразовый сервис создаёт бакет после того, как MinIO готов", () => {
    const bucket = Object.entries(compose.services).find(([name]) => name.includes("bucket"));
    expect(bucket).toBeDefined();
    const [, service] = bucket ?? ["", {}];
    expect(JSON.stringify(service.depends_on)).toMatch(/minio/);
    expect(JSON.stringify(service.depends_on)).toMatch(/service_healthy/);
    expect(service.restart ?? "no").toBe("no");
  });
});

describe("локальное окружение: скрипты баз данных", () => {
  const pkg = JSON.parse(read("package.json"));

  it("[SH-003 AC-4] в package.json есть db:up, db:down и db:reset-test", () => {
    expect(pkg.scripts["db:up"]).toContain("docker compose up");
    expect(pkg.scripts["db:down"]).toContain("docker compose down");
    expect(pkg.scripts["db:reset-test"]).toContain("db-reset-test");
  });

  it("[SH-003 AC-4] сброс затрагивает только тестовую БД, имя которой отличается от dev", () => {
    const plan = planTestDatabaseReset({
      DATABASE_URL: "postgres://u:p@localhost:5432/studentshub",
      TEST_DATABASE_URL: "postgres://u:p@localhost:5432/studentshub_test",
    });
    expect(plan.database).toBe("studentshub_test");
    expect(plan.database).not.toBe("studentshub");
  });

  it("[SH-003 AC-4] сброс отказывается работать, если тестовая БД совпадает с dev", () => {
    expect(() =>
      planTestDatabaseReset({
        DATABASE_URL: "postgres://u:p@localhost:5432/studentshub",
        TEST_DATABASE_URL: "postgres://u:p@localhost:5432/studentshub",
      }),
    ).toThrow(/dev/i);
  });

  it("[SH-003 AC-4] сброс отказывается работать, если имя тестовой БД не оканчивается на _test", () => {
    expect(() =>
      planTestDatabaseReset({
        DATABASE_URL: "postgres://u:p@localhost:5432/studentshub",
        TEST_DATABASE_URL: "postgres://u:p@localhost:5432/studentshub_copy",
      }),
    ).toThrow(/_test/);
  });
});
