"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";
import { LayoutDashboard, Bot, MessageSquare, Settings, Users } from "lucide-react";

const nav = [
  { href: "/", label: "Overview", icon: LayoutDashboard },
  { href: "/agents", label: "Agents", icon: Bot },
  { href: "/conversations", label: "Conversations", icon: MessageSquare },
  { href: "/leads", label: "Leads", icon: Users },
  { href: "/settings", label: "Settings", icon: Settings },
];

export default function Sidebar() {
  const pathname = usePathname();

  return (
    <aside className="w-56 min-h-screen bg-[#0d0d14] border-r border-[#1e1e2e] flex flex-col">
      {/* Logo */}
      <div className="h-16 flex items-center px-5 border-b border-[#1e1e2e]">
        <span className="text-lg font-bold text-white">Afterlife</span>
        <span className="ml-2 text-xs bg-green-500/20 text-green-400 px-2 py-0.5 rounded-full font-medium border border-green-500/20">
          WA
        </span>
      </div>

      {/* Nav */}
      <nav className="flex-1 p-3 space-y-1">
        {nav.map(({ href, label, icon: Icon }) => {
          const active =
            href === "/" ? pathname === "/" : pathname.startsWith(href);
          return (
            <Link
              key={href}
              href={href}
              className={cn(
                "flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors",
                active
                  ? "bg-indigo-600 text-white"
                  : "text-[#8888aa] hover:bg-[#1a1a26] hover:text-white"
              )}
            >
              <Icon size={16} />
              {label}
            </Link>
          );
        })}
      </nav>

      <div className="p-4 text-xs text-[#44445a] border-t border-[#1e1e2e]">
        Afterlife Adapter v2
      </div>
    </aside>
  );
}
