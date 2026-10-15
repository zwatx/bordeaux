// One small stroke icon set (16px grid, 1.5px stroke) for the Workbench variant.
const PATHS = {
  search: <><circle cx="7" cy="7" r="4.25" /><path d="M10.25 10.25L13.5 13.5" /></>,
  check: <path d="M3.5 8.5L6.5 11.5L12.5 4.5" />,
  play: <path d="M5.5 3.75V12.25L12.25 8Z" fill="currentColor" strokeLinejoin="round" />,
  pause: <><path d="M5.5 4V12" /><path d="M10.5 4V12" /></>,
  flag: <><path d="M4.5 14V2.5" /><path d="M4.5 3H11.5L10 5.75L11.5 8.5H4.5" strokeLinejoin="round" /></>,
  undo: <><path d="M5.5 3.5L2.75 6.25L5.5 9" strokeLinejoin="round" /><path d="M3 6.25H9.5A3.25 3.25 0 0 1 9.5 12.75H7" /></>,
  redo: <><path d="M10.5 3.5L13.25 6.25L10.5 9" strokeLinejoin="round" /><path d="M13 6.25H6.5A3.25 3.25 0 0 0 6.5 12.75H9" /></>,
  x: <><path d="M4.5 4.5L11.5 11.5" /><path d="M11.5 4.5L4.5 11.5" /></>,
  chev: <path d="M6 4L10 8L6 12" strokeLinejoin="round" />,
};

export function Icon({ name, className = "" }) {
  return (
    <svg className={"wb-icon " + className} width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}
