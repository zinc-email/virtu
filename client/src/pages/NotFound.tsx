// The 404 page — the router's defaultNotFoundComponent, and ALSO what the
// admin pages render on a 403: a non-admin deep-linking /admin sees exactly
// what any bogus URL shows, so the URL space never advertises an operator
// area. (The API itself answers 403 — it's in the committed public spec, so
// there's nothing to hide server-side; this is purely about the browser
// surface.)

import { Link } from "@tanstack/react-router";
import { css } from "styled-system/css";
import { Section, ui } from "src/ui";

export function NotFoundPage() {
  return (
    <Section narrow>
      <header className={css({ marginBottom: "2.11rem" })}>
        <h1 className={ui.h1}>Not found.</h1>
      </header>
      <p className={ui.lead}>There's nothing at this address.</p>
      <p>
        <Link to="/" className={ui.link}>
          Back to your emails
        </Link>
      </p>
    </Section>
  );
}
