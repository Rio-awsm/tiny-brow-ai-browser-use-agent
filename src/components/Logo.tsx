/** Browser frame with a pointer inside. Matches the toolbar icon in scripts/make-icons.ts. */
export function Logo({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      className={className}
      aria-hidden="true"
      focusable="false"
    >
      <rect
        x="3.1"
        y="4.5"
        width="17.8"
        height="15"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.7"
      />
      <path
        d="M3.95 8.2V7.5a2.15 2.15 0 0 1 2.15-2.15h11.8A2.15 2.15 0 0 1 20.05 7.5v.7z"
        fill="currentColor"
      />
      <path
        d="M8.8 9.2v7.81l2.04-1.97 1.15 2.51 1.65-.76-1.17-2.52 2.82-.34z"
        fill="currentColor"
      />
    </svg>
  );
}
