import { type ReactNode, useEffect, useState } from "react";

export function go(path: string, replace = false): void {
  if (replace) history.replaceState(null, "", path);
  else history.pushState(null, "", path);
  dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): { path: string; query: URLSearchParams } {
  const [loc, setLoc] = useState(() => ({ path: location.pathname, query: new URLSearchParams(location.search) }));
  useEffect(() => {
    const on = () => setLoc({ path: location.pathname, query: new URLSearchParams(location.search) });
    addEventListener("popstate", on);
    return () => removeEventListener("popstate", on);
  }, []);
  return loc;
}

export function Link({ to, className, children, ...rest }: { to: string; className?: string; children: ReactNode; "aria-label"?: string }) {
  return (
    <a
      href={to}
      className={className}
      {...rest}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
        e.preventDefault();
        go(to);
      }}
    >
      {children}
    </a>
  );
}
