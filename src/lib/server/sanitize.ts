import sanitizeHtml from 'sanitize-html';

/** What an email body may contain after the editor. Everything else is dropped. */
export function sanitizeBody(html: string): string {
  return sanitizeHtml(html ?? '', {
    allowedTags: ['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'a', 'ul', 'ol', 'li', 'blockquote', 'div', 'span'],
    allowedAttributes: { a: ['href'], '*': [] },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: { a: (tag, attrs) => ({ tagName: 'a', attribs: { href: attrs.href ?? '' } }) }
  }).replace(/<p><\/p>/g, '<p><br></p>');
}

/**
 * An inbound email as it may be shown inside the Inbox: text formatting, links and tables survive; scripts, styles,
 * forms and every image (tracking pixels included) are dropped. Links open in a new tab.
 */
export function sanitizeInboundHtml(html: string): string {
  return sanitizeHtml(html ?? '', {
    allowedTags: ['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'a', 'ul', 'ol', 'li', 'blockquote', 'div', 'span', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'h1', 'h2', 'h3', 'h4', 'pre', 'code', 'hr'],
    allowedAttributes: { a: ['href', 'target', 'rel'], td: ['colspan'], th: ['colspan'], '*': [] },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    transformTags: { a: (tag, attrs) => ({ tagName: 'a', attribs: { href: attrs.href ?? '', target: '_blank', rel: 'noopener noreferrer' } }) },
    exclusiveFilter: (frame) => frame.tag === 'div' && !frame.text.trim() && !frame.tagPosition
  });
}
