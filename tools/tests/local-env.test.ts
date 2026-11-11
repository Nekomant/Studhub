import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import YAML from "yaml";
import { planTestDatabaseReset } from "../../scripts/db-reset-test.mjs";

const repoRoot = resolve(import.meta.dirname, "../..");
const read = (path: string) => readFileSync(join(repoRoot, path), "utf8");

type Compose = {
  services: Record<string, { image?: string; volumes?: string[]; command?: string[]; environment?: unknown }>;
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

  it("[SH-003 AC-1] garage — S3 API, данные и метаданные в именованных томах", () => {
    const garage = compose.services.garage;
    expect(garage?.image).toMatch(/^dxflrs\/garage:v\d/);
    for (const path of ["/var/lib/garage/data", "/var/lib/garage/meta"]) {
      const mount = garage?.volumes?.find((v) => v.endsWith(`:${path}`));
      expect(mount, `нет тома для ${path}`).toBeDefined();
      const volumeName = mount?.split(":")[0] ?? "";
      expect(Object.keys(compose.volumes)).toContain(volumeName);
    }
  });

  it("[SH-003 AC-1] бакет и ключ создаются при старте Garage, имя бакета берётся из S3_BUCKET", () => {
    const garage = compose.services.garage;
    expect(garage?.command).toContain("--default-bucket");
    expect(garage?.command).toContain("--single-node");
    expect(JSON.stringify(garage?.environment)).toContain("S3_BUCKET");
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

  it("[SH-003 AC-4] сброс отказывается работать с не локальным хостом", () => {
    expect(() =>
      planTestDatabaseReset({
        DATABASE_URL: "postgres://u:p@localhost:5432/studentshub",
        TEST_DATABASE_URL: "postgres://u:p@db.example.com:5432/studentshub_test",
      }),
    ).toThrow(/локальн/);
  });
});
