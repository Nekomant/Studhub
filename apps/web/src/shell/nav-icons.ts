import type { NavKey } from "@studhub/client-core";
import {
  CalendarCheck,
  CalendarDays,
  Ellipsis,
  FileText,
  FolderOpen,
  type LucideIcon,
  Settings,
  Users,
  Wallet,
} from "lucide-react";

// Иконки навигации: lucide, контурные (design-system.md §7).
export const navIcons: Record<NavKey, LucideIcon> = {
  today: CalendarCheck,
  schedule: CalendarDays,
  students: Users,
  materials: FolderOpen,
  more: Ellipsis,
  payments: Wallet,
  templates: FileText,
  settings: Settings,
};
