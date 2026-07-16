import { Link } from "react-router";

/**
 * Column layout shared by the bookmarks, profile, and settings pages:
 * a sticky header with a link back to the timeline above the page content.
 *
 * @param heading - Content rendered inside the sticky header below the back link.
 */
export function SubpageShell({ heading, children }: { heading: React.ReactNode; children: React.ReactNode }) {
  return (
    <main className="subpage">
      <section className="subpage-column">
        <header className="subpage-header">
          <Link to="/" className="back-link">
            ← タイムラインへ戻る
          </Link>
          {heading}
        </header>
        {children}
      </section>
    </main>
  );
}
