#!/usr/bin/env bash
# Единый список обязательных значений wal-g в .env.backup (SH-012). Файл подключают lib.sh и install.sh, сам он ничего не запускает.
# Скрипты берут из него проверку require_env, экспорт export_walg_env, передачу в контейнеры восстановления и проверку install.sh.
WALG_VARS=(WALG_S3_PREFIX AWS_ENDPOINT AWS_REGION AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY WALG_LIBSODIUM_KEY)
