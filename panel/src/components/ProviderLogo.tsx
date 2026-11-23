import React, { useEffect, useState } from 'react';
import { api } from '../api';
import type { BenchmarkSourceKey, ProviderLogoData } from '../types';

interface ProviderLogoProps {
  slug: string;
  name: string;
  size?: number;
}

function computeInitials(name: string, slug: string): string {
  const source = (name || slug || 'BF').trim();
  const parts = source.split(/[\s\-_/]+/).filter(Boolean);
  if (parts.length >= 2) {
    return `${parts[0][0] ?? ''}${parts[1][0] ?? ''}`.toUpperCase();
  }
  return source.slice(0, 2).toUpperCase();
}

const ALLOWED_SVG_TAGS = new Set([
  'svg',
  'g',
  'path',
  'circle',
  'ellipse',
  'rect',
  'line',
  'polyline',
  'polygon',
  'defs',
  'lineargradient',
  'radialgradient',
  'stop',
  'clippath',
  'mask',
  'title',
  'desc',
]);

const ALLOWED_SVG_ATTRS = new Set([
  'viewbox',
  'width',
  'height',
  'fill',
  'fill-rule',
  'fill-opacity',
  'stroke',
  'stroke-width',
  'stroke-linecap',
  'stroke-linejoin',
  'stroke-opacity',
  'stroke-dasharray',
  'stroke-dashoffset',
  'stroke-miterlimit',
  'opacity',
  'd',
  'cx',
  'cy',
  'r',
  'rx',
  'ry',
  'x',
  'y',
  'x1',
  'y1',
  'x2',
  'y2',
  'points',
  'transform',
  'id',
  'offset',
  'stop-color',
  'stop-opacity',
  'gradientunits',
  'gradienttransform',
  'clip-path',
  'clip-rule',
  'mask',
  'preserveaspectratio',
  'xmlns',
  'role',
  'aria-hidden',
]);

function sanitizeSvgMarkup(raw: string | null | undefined): string | null {
  if (!raw || typeof raw !== 'string') return null;
  if (typeof DOMParser === 'undefined') return null;
  try {
    const parser = new DOMParser();
    const doc = parser.parseFromString(raw, 'image/svg+xml');
    if (doc.querySelector('parsererror')) return null;
    const root = doc.documentElement;
    if (!root || root.tagName.toLowerCase() !== 'svg') return null;

    const cleanNode = (el: Element): boolean => {
      const tag = el.tagName.toLowerCase();
      if (!ALLOWED_SVG_TAGS.has(tag)) {
        return false;
      }
      for (const attr of Array.from(el.attributes)) {
        const name = attr.name.toLowerCase();
        const val = attr.value.trim().toLowerCase();
        if (
          name.startsWith('on') ||
          !ALLOWED_SVG_ATTRS.has(name) ||
          val.includes('javascript:') ||
          val.includes('data:') ||
          val.includes('expression(')
        ) {
          el.removeAttribute(attr.name);
        }
      }
      for (const child of Array.from(el.childNodes)) {
        if (child.nodeType === Node.ELEMENT_NODE) {
          if (!cleanNode(child as Element)) {
            el.removeChild(child);
          }
        } else if (child.nodeType === Node.COMMENT_NODE) {
          el.removeChild(child);
        }
      }
      return true;
    };

    if (!cleanNode(root)) return null;
    return new XMLSerializer().serializeToString(root);
  } catch {
    return null;
  }
}

export const ProviderLogo: React.FC<ProviderLogoProps> = ({ slug, name, size = 38 }) => {
  const [logo, setLogo] = useState<ProviderLogoData | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLogo(null);

    if (!slug.trim()) {
      setLogo({ hasLogo: false, svg: null });
      return;
    }

    void api.getProviderLogo(slug).then((data) => {
      if (!cancelled) {
        setLogo(data);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [slug]);

  const initials = computeInitials(name, slug);
  const paddingPx = Math.max(6, Math.round(size * 0.21));
  const fontSizeRem = `${Math.max(0.72, Number(((size / 38) * 0.85).toFixed(2)))}rem`;

  const sanitizedSvg = logo?.hasLogo ? sanitizeSvgMarkup(logo.svg) : null;
  const isSafeSvg = Boolean(sanitizedSvg);

  return (
    <span
      className="provider-logo-box"
      style={{
        width: size,
        height: size,
        padding: isSafeSvg ? paddingPx : 0,
        color: 'var(--sub)',
      }}
      title={`Proveedor: ${name || slug}`}
      aria-label={`Logo monocromo de ${name || slug}`}
    >
      {isSafeSvg && sanitizedSvg ? (
        <span
          style={{
            width: '100%',
            height: '100%',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            color: 'var(--sub)',
          }}
          dangerouslySetInnerHTML={{ __html: sanitizedSvg }}
        />
      ) : (
        <span className="provider-logo-fallback" style={{ fontSize: fontSizeRem }}>
          {initials}
        </span>
      )}
    </span>
  );
};

interface BenchmarkSourceIconProps {
  source: BenchmarkSourceKey;
  size?: number;
}

export const BenchmarkSourceIcon: React.FC<BenchmarkSourceIconProps> = ({
  source,
  size = 16,
}) => {
  const commonStyle: React.CSSProperties = {
    width: size,
    height: size,
    color: 'var(--sub)',
    flexShrink: 0,
    display: 'inline-block',
    verticalAlign: 'middle',
  };

  if (source === 'lmarena') {
    return (
      <svg viewBox="0 0 24 24" fill="none" style={commonStyle} aria-hidden="true">
        <path
          d="M5 19V11M12 19V5M19 19V14"
          stroke="currentColor"
          strokeWidth="2.1"
          strokeLinecap="round"
        />
        <path d="M3 19.5H21" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      </svg>
    );
  }

  if (source === 'artificialwatch') {
    return (
      <svg viewBox="0 0 24 24" fill="none" style={commonStyle} aria-hidden="true">
        <polygon
          points="12,3 20,8 17.5,18.5 6.5,18.5 4,8"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinejoin="round"
        />
        <polygon
          points="12,7.5 16,10 14.8,15.2 9.2,15.2 8,10"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  if (source === 'epoch') {
    return (
      <svg viewBox="0 0 24 24" fill="none" style={commonStyle} aria-hidden="true">
        <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.9" />
        <path
          d="M12 7.5V12L15.2 14.2"
          stroke="currentColor"
          strokeWidth="1.9"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
    );
  }

  return (
    <svg viewBox="0 0 24 24" fill="none" style={commonStyle} aria-hidden="true">
      <rect
        x="3.5"
        y="4.5"
        width="17"
        height="15"
        rx="3"
        stroke="currentColor"
        strokeWidth="1.9"
      />
      <path
        d="M7.5 15L10.8 11.2L13.6 13.5L16.8 9"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
};
