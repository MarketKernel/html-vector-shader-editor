// The interface's icons: 24×24, drawn with lines in the current colour, inlined so the
// page needs nothing from elsewhere.

const ICONS: Record<string, string> = {
  select: `<path d="M5 3l14 8-6.2 1.6L10 19z"/><path d="m13 13 5 6"/>`,
  rect: `<rect x="3.5" y="5.5" width="17" height="13" rx="1"/>`,
  ellipse: `<ellipse cx="12" cy="12" rx="9" ry="6.5"/>`,
  line: `<path d="M5 19 19 5"/><circle cx="5" cy="19" r="1.6"/><circle cx="19" cy="5" r="1.6"/>`,
  pen: `<path d="M12 19l7-7 3 3-7 7z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18z"/><path d="M2 2l7.6 7.6"/><circle cx="11" cy="11" r="2"/>`,
  zoom: `<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.9-4.9"/>`,
  'zoom-in': `<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.9-4.9M10.5 7.5v6M7.5 10.5h6"/>`,
  'zoom-out': `<circle cx="10.5" cy="10.5" r="6.5"/><path d="m20 20-4.9-4.9M7.5 10.5h6"/>`,
  pan: `<path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V11"/><path d="M11 10.5V4a1.5 1.5 0 0 1 3 0v6.5"/><path d="M14 10.5V5.5a1.5 1.5 0 0 1 3 0V12"/><path d="M17 9.5a1.5 1.5 0 0 1 3 0V15a7 7 0 0 1-7 7h-1.5c-2.3 0-3.7-.8-5-2.1l-3.1-3.2a1.6 1.6 0 0 1 2.3-2.2L8 16.3"/>`,
  fit: `<path d="M8 3H5a2 2 0 0 0-2 2v3M21 8V5a2 2 0 0 0-2-2h-3M3 16v3a2 2 0 0 0 2 2h3M16 21h3a2 2 0 0 0 2-2v-3"/>`,

  undo: `<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>`,
  redo: `<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>`,
  plus: `<path d="M12 5v14M5 12h14"/>`,
  trash: `<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M10 11v6M14 11v6"/>`,
  duplicate: `<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/>`,
  up: `<path d="m18 15-6-6-6 6"/>`,
  down: `<path d="m6 9 6 6 6-6"/>`,
  eye: `<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>`,
  'eye-off': `<path d="M2 10s3.5 5 10 5 10-5 10-5"/><path d="m4.5 13-2 2.5M9 14.8 8.2 18M15 14.8l.8 3.2M19.5 13l2 2.5"/>`,
  lock: `<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>`,
  unlock: `<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 7.5-2"/>`,
  layers: `<path d="m12 2 10 5-10 5L2 7z"/><path d="m2 17 10 5 10-5"/><path d="m2 12 10 5 10-5"/>`,
  group: `<rect x="2.5" y="2.5" width="19" height="19" rx="2" stroke-dasharray="3 2.4"/><rect x="6" y="6" width="7" height="6" rx="1"/><circle cx="15" cy="15" r="3.2"/>`,
  ungroup: `<rect x="3" y="3" width="9" height="8" rx="1"/><circle cx="16.5" cy="16.5" r="4"/>`,
  front: `<rect x="8" y="8" width="12" height="12" rx="1" fill="currentColor" fill-opacity=".35"/><path d="M4 16V5a1 1 0 0 1 1-1h11"/>`,
  back: `<rect x="4" y="4" width="12" height="12" rx="1" fill="currentColor" fill-opacity=".35"/><path d="M20 8v11a1 1 0 0 1-1 1H8"/>`,
  paste: `<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2"/>`,
  cut: `<circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/>`,
  copy: `<rect x="8" y="8" width="13" height="13" rx="2"/><path d="M4 16a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2"/>`,
  panel: `<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M15 3v18"/>`,
  close: `<path d="M18 6 6 18M6 6l12 12"/>`,
  check: `<path d="M20 6 9 17l-5-5"/>`,
  image: `<rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>`,
  open: `<path d="M4 20h16a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.7-.9L9.6 3.9A2 2 0 0 0 7.9 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2z"/>`,
  save: `<path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/><path d="M17 21v-8H7v8M7 3v5h8"/>`,
  export: `<path d="M12 3v12"/><path d="m7 8 5-5 5 5"/><path d="M5 15v4a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-4"/>`,
  code: `<path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>`,
  file: `<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/>`,
  dot: `<circle cx="12" cy="12" r="1.5" fill="currentColor"/>`,
};

export function icon(name: string, className = 'icon'): string {
  const body = ICONS[name] ?? ICONS.dot!;
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
}

// The page's own icon: a pen nib over a curve, for the tab and the menu bar.
export const APP_ICON = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect x="4" y="4" width="56" height="56" rx="14" fill="#2f6df6"/><path d="M12 46C20 16 36 52 52 18" fill="none" stroke="#ffd23f" stroke-width="5" stroke-linecap="round"/><circle cx="12" cy="46" r="5" fill="#fff"/><circle cx="52" cy="18" r="5" fill="#fff"/><rect x="27" y="27" width="10" height="10" rx="2" fill="#ff5d73" stroke="#fff" stroke-width="2"/></svg>`;
