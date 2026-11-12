import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

// Помощник shadcn/ui: собирает классы условно и убирает конфликты утилит Tailwind.
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
