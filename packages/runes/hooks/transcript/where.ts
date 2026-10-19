export const where = { cwd: "", home: "" };

export const shortPath = (path: string) => {
  const under = (dir: string) => (dir.endsWith("/") ? dir : `${dir}/`);
  if (where.cwd && path.startsWith(under(where.cwd)))
    return path.slice(under(where.cwd).length);
  if (where.home && path.startsWith(under(where.home)))
    return `~/${path.slice(under(where.home).length)}`;
  return path;
};
