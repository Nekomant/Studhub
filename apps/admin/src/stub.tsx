// Заглушка админки платформы (ADR-0009). Вход, API и экраны добавят задачи SH-084, SH-085 и SH-088.
export function Stub() {
  return (
    <main className="mx-auto max-w-3xl p-4 md:p-8">
      <h1 className="title-l md:title-xl">Админка платформы</h1>
      <p className="body mt-2 text-ink-muted">Заглушка: экраны появятся в следующих задачах</p>
    </main>
  );
}
