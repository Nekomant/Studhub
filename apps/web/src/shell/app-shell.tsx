import { desktopNav, mobileTabs, type NavEntry } from "@studhub/client-core";
import { Link, Outlet } from "@tanstack/react-router";
import { navIcons } from "./nav-icons.ts";

const navigationLabel = "Основная навигация";

// (М) Нижняя панель, ширина меньше 768 px: активная вкладка с капсулой plum-soft (design-system.md §7).
function BottomBar() {
  return (
    <nav
      aria-label={navigationLabel}
      className="fixed inset-x-0 bottom-0 flex h-tabbar border-t border-line bg-surface md:hidden"
    >
      {mobileTabs.map((entry) => (
        <BottomBarLink key={entry.key} entry={entry} />
      ))}
    </nav>
  );
}

function BottomBarLink({ entry }: { entry: NavEntry }) {
  const Icon = navIcons[entry.key];
  return (
    <Link
      to={entry.path}
      className="group flex flex-1 flex-col items-center justify-center gap-0.5 text-ink-muted aria-[current=page]:text-plum-ink"
    >
      <span className="flex h-7 w-14 items-center justify-center rounded-pill transition-colors duration-150 group-aria-[current=page]:bg-plum-soft">
        <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
      </span>
      <span className="caption">{entry.label}</span>
    </Link>
  );
}

// (Д) Боковая панель, ширина от 768 px: активный пункт с фоном plum-soft.
function Sidebar() {
  return (
    <nav
      aria-label={navigationLabel}
      className="fixed inset-y-0 left-0 hidden w-64 flex-col gap-1 border-r border-line bg-surface p-4 md:flex"
    >
      <p className="title-m mb-3 px-3 pt-2 text-plum-ink">Studhub</p>
      {desktopNav.map((entry) => (
        <SidebarLink key={entry.key} entry={entry} />
      ))}
    </nav>
  );
}

function SidebarLink({ entry }: { entry: NavEntry }) {
  const Icon = navIcons[entry.key];
  return (
    <Link
      to={entry.path}
      className="body-strong flex h-control-desktop items-center gap-3 rounded-md px-3 text-ink-muted transition-colors duration-150 hover:bg-sunken aria-[current=page]:bg-plum-soft aria-[current=page]:text-plum-ink"
    >
      <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
      {entry.label}
    </Link>
  );
}

export function AppShell() {
  return (
    <div className="min-h-dvh bg-background text-foreground">
      <Sidebar />
      <main className="pb-tabbar md:pb-0 md:pl-64">
        <Outlet />
      </main>
      <BottomBar />
    </div>
  );
}
