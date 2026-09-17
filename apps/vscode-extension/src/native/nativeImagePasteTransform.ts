export type DataUriReplacement = {
  replacement: string;
  matched: boolean;
};

export type DataUriTransformer = (dataUri: string, mimeType: string) => string;

const DATA_URI_MIME_RE = /^data:(image\/[a-zA-Z0-9.+-]+);base64,/i;
const BARE_DATA_URI_RE = /^\s*(data:(image\/[a-zA-Z0-9.+-]+);base64,\S+)\s*$/i;
const MARKDOWN_IMAGE_DATA_URI_RE = /!\[([^\]]*)\]\(\s*(data:(image\/[a-zA-Z0-9.+-]+);base64,[^)]+?)(\s+(?:"[^"]*"|'[^']*'))?\s*\)/gi;
const HTML_IMAGE_DATA_URI_RE = /(<img\b[^>]*\bsrc=["'])(data:(image\/[a-zA-Z0-9.+-]+);base64,[^"']+)(["'][^>]*>)/gi;

function getMimeType(dataUri: string): string | null {
  return dataUri.match(DATA_URI_MIME_RE)?.[1]?.toLowerCase() ?? null;
}

export function replaceMarkdownImageDataUris(
  text: string,
  transform: DataUriTransformer,
): DataUriReplacement {
  let matched = false;
  const replacement = text.replace(
    MARKDOWN_IMAGE_DATA_URI_RE,
    (_full, alt: string, dataUri: string, mimeType: string, titlePart: string | undefined) => {
      matched = true;
      const path = transform(dataUri, mimeType.toLowerCase());
      return `![${alt}](${path}${titlePart ?? ''})`;
    },
  );
  return { replacement, matched };
}

export function replaceHtmlImageDataUris(
  text: string,
  transform: DataUriTransformer,
): DataUriReplacement {
  let matched = false;
  const replacement = text.replace(
    HTML_IMAGE_DATA_URI_RE,
    (_full, prefix: string, dataUri: string, mimeType: string, suffix: string) => {
      matched = true;
      const path = transform(dataUri, mimeType.toLowerCase());
      return `${prefix}${path}${suffix}`;
    },
  );
  return { replacement, matched };
}

export function replaceBareImageDataUri(
  text: string,
  transform: DataUriTransformer,
): DataUriReplacement {
  const match = text.match(BARE_DATA_URI_RE);
  if (!match) {
    return { replacement: text, matched: false };
  }
  const dataUri = match[1];
  const mimeType = match[2].toLowerCase();
  return {
    replacement: `![](${transform(dataUri, mimeType)})`,
    matched: true,
  };
}

export function replaceInlineImageDataUris(
  text: string,
  transform: DataUriTransformer,
): DataUriReplacement {
  let current = text;
  let matched = false;

  const markdown = replaceMarkdownImageDataUris(current, transform);
  current = markdown.replacement;
  matched = matched || markdown.matched;

  const html = replaceHtmlImageDataUris(current, transform);
  current = html.replacement;
  matched = matched || html.matched;

  const bare = replaceBareImageDataUri(current, transform);
  current = bare.replacement;
  matched = matched || bare.matched;

  return { replacement: current, matched };
}

export function isImageDataUri(text: string): boolean {
  return getMimeType(text) !== null;
}
