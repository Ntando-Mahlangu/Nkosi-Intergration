import { useId } from "react";

/**
 * CSI logo mark: one continuous gradient stroke (orange → yellow → magenta → violet → blue) with a dot.
 * Vector recreation of the supplied logo; the same artwork is in /public/logo-mark.svg for CSS backgrounds.
 */
export function LogoMark({ size = 32, title = "CSI Workspace" }: { size?: number; title?: string }) {
  const id = useId().replace(/:/g, "");
  return (
    <svg width={size} height={size} viewBox="40 100 360 260" role="img" aria-label={title}>
      <defs>
        <linearGradient id={`${id}a`} x1="62" y1="318" x2="216" y2="290" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#f2642f" /><stop offset="0.55" stopColor="#f7b33b" /><stop offset="1" stopColor="#ef6a5a" /></linearGradient>
        <linearGradient id={`${id}b`} x1="216" y1="290" x2="380" y2="240" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#e3457c" /><stop offset="0.5" stopColor="#c22e9e" /><stop offset="1" stopColor="#9a2fd6" /></linearGradient>
        <linearGradient id={`${id}c`} x1="372" y1="292" x2="268" y2="314" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#9a2fd6" /><stop offset="1" stopColor="#6a33ee" /></linearGradient>
        <linearGradient id={`${id}d`} x1="268" y1="314" x2="300" y2="144" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#6a33ee" /><stop offset="0.6" stopColor="#3a5cff" /><stop offset="1" stopColor="#2f76ff" /></linearGradient>
      </defs>
      <g fill="none" strokeWidth="26" strokeLinecap="round" strokeLinejoin="round">
        <path stroke={`url(#${id}d)`} d="M268 314 C236 286 222 222 244 182 C262 150 288 140 306 144" />
        <path stroke={`url(#${id}c)`} d="M372 292 C354 330 300 342 268 314" />
        <path stroke={`url(#${id}a)`} d="M62 318 C105 302 148 290 172 262 C196 234 190 192 160 194 C128 196 112 242 126 275 C140 306 186 312 216 290" />
        <path stroke={`url(#${id}b)`} d="M216 290 C246 268 272 232 312 216 C362 198 392 250 372 292" />
      </g>
      <circle cx="324" cy="128" r="13" fill="#a62ec8" />
    </svg>
  );
}
