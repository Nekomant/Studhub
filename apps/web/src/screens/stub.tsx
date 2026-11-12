import type { ReactNode } from "react";

// Заглушка экрана: заголовок и пояснение. Настоящие экраны заменят её в задачах своих этапов.
export function Stub({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <section className="mx-auto max-w-3xl p-4 md:p-8">
      <h1 className="title-l md:title-xl">{title}</h1>
      <p className="body mt-2 text-ink-muted">Экран появится в следующих задачах.</p>
      {children}
    </section>
  );
}
