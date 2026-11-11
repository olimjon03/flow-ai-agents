"use client";

import { AudioLines, Menu, X } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";
import { navigation } from "../lib/navigation";

export function Sidebar() {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const ToggleIcon = open ? X : Menu;

  return (
    <aside className="sidebar" onKeyDown={(event) => {
      if (event.key === "Escape" && open) {
        setOpen(false);
        document.getElementById("nav-toggle")?.focus();
      }
    }}>
      <div className="sidebar-header">
        <Link href="/" className="brand flex items-center gap-3" onClick={() => setOpen(false)}>
          <AudioLines aria-hidden="true" size={34} strokeWidth={2.7} className="text-violet-400" />
          Flow AI
        </Link>
        <button
          id="nav-toggle"
          type="button"
          className="nav-toggle icon-button"
          aria-label={open ? "Close navigation" : "Open navigation"}
          aria-expanded={open}
          aria-controls="workspace-navigation"
          onClick={() => setOpen(!open)}
        >
          <ToggleIcon aria-hidden="true" size={22} />
        </button>
      </div>
      <nav id="workspace-navigation" aria-label="Workspace" className={open ? "navigation open" : "navigation"}>
        {navigation.map(({ href, icon: Icon, label }) => (
          <Link key={href} href={href} aria-current={pathname === href ? "page" : undefined} onClick={() => setOpen(false)}>
            <Icon aria-hidden="true" size={23} strokeWidth={1.65} />
            {label}
          </Link>
        ))}
      </nav>
    </aside>
  );
}
