#!/usr/bin/env node
// Пересоздаёт тестовую БД в контейнере Postgres. Dev-БД этот скрипт не трогает:
// он удаляет только базу из TEST_DATABASE_URL и только если её имя отличается от dev и оканчивается на _test.
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

function databaseName(url, label) {
  if (!url) throw new Error(`${label} не задан`);
  return new URL(url).pathname.replace(/^\//, "");
}

export function planTestDatabaseReset(env) {
  const devName = databaseName(env.DATABASE_URL, "DATABASE_URL");
  const testName = databaseName(env.TEST_DATABASE_URL, "TEST_DATABASE_URL");
  if (testName === devName) {
    throw new Error(`TEST_DATABASE_URL указывает на dev-БД «${devName}»: имена совпадают, сброс отменён`);
  }
  if (!testName.endsWith("_test")) {
    throw new Error(`имя тестовой БД должно оканчиваться на _test, сейчас «${testName}»`);
  }
  if (!/^[a-z0-9_]+$/.test(testName)) {
    throw new Error(`имя тестовой БД содержит недопустимые символы: «${testName}»`);
  }
  const url = new URL(env.TEST_DATABASE_URL);
  // Скрипт работает только с контейнером compose на этой машине: чужой сервер он не тронет.
  if (!["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
    throw new Error(`сброс работает только с локальной БД из compose, а в TEST_DATABASE_URL хост «${url.hostname}»`);
  }
  const user = decodeURIComponent(url.username);
  return { database: testName, user };
}

function main() {
  const { database, user } = planTestDatabaseReset(process.env);
  // Каждая команда — отдельным -c: psql выполняет одну строку -c в одной транзакции, а DROP DATABASE в ней нельзя.
  execFileSync(
    "docker",
    [
      "compose",
      "exec",
      "-T",
      "postgres",
      "psql",
      "-U",
      user,
      "-d",
      "postgres",
      "-v",
      "ON_ERROR_STOP=1",
      "-c",
      `DROP DATABASE IF EXISTS ${database} WITH (FORCE)`,
      "-c",
      `CREATE DATABASE ${database}`,
    ],
    { stdio: "inherit" },
  );
  console.log(`Тестовая БД «${database}» пересоздана. Dev-БД не затронута.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
