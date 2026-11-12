// Единый источник времени сервера. Код сервера берёт время только отсюда: `Date.now()` и `new Date()` без аргументов
// запрещены (тест clock.test.ts). Так API-тесты могут задать время командой `POST /__test/clock` (docs/process.md §8.3).

export type Clock = {
  // Каждый вызов возвращает новый объект Date: изменение результата не сдвигает часы.
  now(): Date;
};

// Управляемые часы: стоят на заданном времени, пока их не вернут к системному.
export type ControllableClock = Clock & {
  set(date: Date): void;
  reset(): void;
};

export function createSystemClock(): Clock {
  return { now: () => new Date() };
}

export function createControllableClock(initial?: Date): ControllableClock {
  let fixed: Date | undefined = initial === undefined ? undefined : new Date(initial);
  return {
    now: () => (fixed === undefined ? new Date() : new Date(fixed)),
    set(date) {
      fixed = new Date(date);
    },
    reset() {
      fixed = undefined;
    },
  };
}
