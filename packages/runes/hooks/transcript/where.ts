// set by register.tsx at session.start; a draw has no cwd or HOME of its own
export const where = { cwd: "", home: "" };

// a path under the cwd drops it, one under HOME starts at ~
export const shortPath = (path: string) => {
  const under = (dir: string) => (dir.endsWith("/") ? dir : `${dir}/`);
  if (where.cwd && path.startsWith(under(where.cwd)))
    return path.slice(under(where.cwd).length);
  if (where.home && path.startsWith(under(where.home)))
    return `~/${path.slice(under(where.home).length)}`;
  return path;
};
