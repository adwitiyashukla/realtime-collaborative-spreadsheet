import { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import type { User } from "../shared/protocol.ts";
import { api } from "./api.ts";
import { APP_NAME } from "./dialogs.tsx";
import { EditorPage } from "./editor.tsx";
import { AuthPage, Home, Landing } from "./pages.tsx";
import { Link, useRoute } from "./router.tsx";
import "./styles.css";

function App() {
  const { path, query } = useRoute();
  const [user, setUser] = useState<User | null | undefined>(undefined);
  useEffect(() => {
    api.me().then(
      (r) => setUser(r.user),
      () => setUser(null),
    );
  }, []);
  useEffect(() => {
    if (!path.startsWith("/s/")) document.title = APP_NAME;
  }, [path]);
  if (user === undefined) return <main className="center-page" />;
  const sheet = /^\/s\/([0-9A-Za-z]{6,24})$/.exec(path);
  if (sheet) return <EditorPage id={sheet[1]} user={user} onUser={setUser} />;
  if (path === "/") return <Landing user={user} onUser={setUser} />;
  if (path === "/login" || path === "/signup") return <AuthPage mode={path === "/login" ? "login" : "signup"} next={query.get("next")} user={user} onUser={setUser} />;
  if (path === "/sheets") return <Home user={user} onUser={setUser} />;
  return (
    <main className="center-page">
      <div className="gate">
        <h1>Page not found</h1>
        <p className="muted">There is nothing at this address.</p>
        <Link to="/" className="button primary">
          Go to the start page
        </Link>
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
