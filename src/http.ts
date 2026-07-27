/**
 * Response helpers and the shared page chrome, lifted out of the old
 * src/authorize.ts so the consent screen, the installation picker and the
 * post-install landing page all render the same way.
 */

export function problem(status: number, message: string): Response {
	return new Response(JSON.stringify({ error: message }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

export function html(body: string, status = 200): Response {
	return new Response(body, {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			// These pages carry an OAuth handshake; nothing should frame or cache them.
			"Cache-Control": "no-store",
			"X-Frame-Options": "DENY",
			"Referrer-Policy": "no-referrer",
		},
	});
}

export function escapeHtml(value: string): string {
	return value
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&#39;");
}

const STYLES = `
  :root { color-scheme: light dark; }
  body {
    font: 15px/1.5 system-ui, -apple-system, sans-serif;
    max-width: 32rem; margin: 0 auto; padding: 3rem 1.25rem;
  }
  h1 { font-size: 1.25rem; margin: 0 0 .5rem; }
  p { color: color-mix(in srgb, currentColor 65%, transparent); margin: 0 0 1.25rem; }
  button {
    margin-top: 1rem; width: 100%; padding: .625rem; font: inherit; font-weight: 600;
    border: 0; border-radius: .375rem; cursor: pointer;
    /* Not currentColor: it would resolve against this rule's own color. */
    background: CanvasText; color: Canvas;
  }
  .error {
    padding: .625rem .75rem; border-radius: .375rem; margin-bottom: 1.25rem;
    background: color-mix(in srgb, crimson 15%, transparent); color: crimson;
  }
  .hint { font-size: .8125rem; margin: .5rem 0 0; }
  ul.plain { list-style: none; padding: 0; margin: 0 0 1.25rem; }
  ul.plain li { margin: 0 0 .5rem; }
  code {
    font-family: ui-monospace, monospace; font-size: .875em;
    background: color-mix(in srgb, currentColor 10%, transparent);
    padding: .125rem .375rem; border-radius: .25rem;
  }
  .choice {
    display: block; width: 100%; text-align: left; margin: 0 0 .5rem; padding: .75rem;
    border: 1px solid color-mix(in srgb, currentColor 30%, transparent);
    border-radius: .375rem; background: transparent; color: inherit;
    font: inherit; cursor: pointer;
  }
  .choice strong { display: block; }
  .choice span { font-size: .8125rem; opacity: .65; }
`;

/** Wraps page content in the shared shell. `title` and `body` must be pre-escaped. */
export function page(title: string, body: string): string {
	return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>${STYLES}</style>
</head>
<body>
${body}
</body>
</html>`;
}
