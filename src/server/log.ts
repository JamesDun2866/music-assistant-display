// Log fixed event names and sanitized operational codes, never upstream payloads or URLs.
export function log(event: string, code?: string): void {
  console.log(JSON.stringify({ at: new Date().toISOString(), event, ...(code ? { code } : {}) }));
}
