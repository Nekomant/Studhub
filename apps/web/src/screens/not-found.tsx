import { startPath } from "@studhub/client-core";
import { Link } from "@tanstack/react-router";

export function NotFound() {
  return (
    <section className="mx-auto max-w-3xl p-4 md:p-8">
      <h1 className="title-l md:title-xl">Страница не найдена</h1>
      <p className="body mt-2">
        <Link to={startPath} className="text-plum-ink underline">
          Открыть «Сегодня»
        </Link>
      </p>
    </section>
  );
}
