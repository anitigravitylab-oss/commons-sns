import { Link, useLocation } from "react-router";

/**
 * Column layout shared by the bookmarks, profile, and settings pages:
 * a sticky header with a link back to the timeline above the page content.
 *
 * Navigation from the timeline passes the originating URL as
 * `location.state.backTo` so the back link restores the selected tab;
 * direct visits fall back to the recommended timeline.
 *
 * @param heading - Content rendered inside the sticky header below the back link.
 */
export function SubpageShell({ heading, children }: { heading: React.ReactNode; children: React.ReactNode }) {
  const location = useLocation();
  const backTo = (location.state as { backTo?: string } | null)?.backTo ?? "/";
  return (
    <main className="subpage">
      <section className="subpage-column">
        <header className="subpage-header">
          <Link to={backTo} className="back-link">
            ← タイムラインへ戻る
          </Link>
          {heading}
        </header>
        {children}
      </section>
    </main>
  );
}
