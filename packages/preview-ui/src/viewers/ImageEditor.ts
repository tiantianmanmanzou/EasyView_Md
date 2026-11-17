import * as React from 'react';
import type { PreviewDescriptor } from '@easyview/contracts';
import type { FileViewerHandle } from '@file-viewer/react-full';
import type { PreviewHost } from '../types';
import { h } from './shared';
import { usePreviewUnsaved } from './usePreviewUnsaved';
import { tPreview } from '../preview.i18n';
import {
  DocumentDiscardIcon,
  DocumentSaveIcon,
  ImageCropIcon,
  ImageRotateLeftIcon,
  ImageRotateRightIcon,
} from './DocumentRouteChrome';
import {
  cropPixels,
  DEFAULT_CROP,
  dragCropRect,
  drawEditedImage,
  encodeCanvas,
  imageMimeType,
  rotate,
  rotateCropRect,
  rotatedSize,
  type CropHandle,
  type ImageCropRect,
  type ImageRotation,
  type QuarterTurn,
} from '../image/imageEdit';

interface ImageEdit { rotation: ImageRotation; crop: ImageCropRect | null }

const HANDLES: readonly CropHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

/** The image renderer's box around the picture; it takes the turned picture's size. */
export const IMAGE_FRAME_SELECTOR = '.image-frame';

function ImageEditButton(props: {
  label: string;
  icon: () => React.ReactElement;
  onClick: () => void;
  pressed?: boolean;
  disabled?: boolean;
}): React.ReactElement {
  return h('button', {
    type: 'button',
    className: 'preview-chrome-btn preview-chrome-btn--icon preview-image-edit-btn',
    title: props.label,
    'aria-label': props.label,
    'aria-pressed': props.pressed,
    disabled: props.disabled,
    onClick: (event: React.MouseEvent<HTMLButtonElement>) => {
      event.stopPropagation();
      props.onClick();
    },
  }, h(props.icon));
}

/**
 * Rotate / crop on the image preview itself: the viewer turns the picture and keeps its zoom and
 * scroll, and the crop box is drawn over the picture (`overlay`, placed in the image frame).
 * Saving overwrites the source file through the host.
 */
export function useImageEditor(props: {
  descriptor: PreviewDescriptor;
  sourceUrl: string;
  viewerRef: React.RefObject<FileViewerHandle | null>;
  writeBytes: NonNullable<PreviewHost['writeBytes']>;
  host?: PreviewHost;
  onSaved: (saved: Blob) => void;
}): { actions: React.ReactElement; overlay: React.ReactElement | null } {
  const { descriptor, sourceUrl, viewerRef, writeBytes, host, onSaved } = props;
  const [edit, setEdit] = React.useState<ImageEdit | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [saving, setSaving] = React.useState(false);

  const turn = (direction: QuarterTurn) => {
    setEdit((current) => ({
      rotation: rotate(current?.rotation ?? 0, direction),
      crop: current?.crop ? rotateCropRect(current.crop, direction) : null,
    }));
  };
  const toggleCrop = () => {
    setEdit((current) => ({ rotation: current?.rotation ?? 0, crop: current?.crop ? null : DEFAULT_CROP }));
  };
  const discard = () => {
    setEdit(null);
    setError(null);
  };
  const dirty = !!edit && (edit.rotation !== 0 || edit.crop !== null);

  const save = React.useCallback(async (): Promise<void> => {
    if (!edit || saving || !dirty) return;
    setSaving(true);
    setError(null);
    try {
      const response = await fetch(sourceUrl);
      if (!response.ok) throw new Error(tPreview('image.readFailed', { status: response.status }));
      const image = await createImageBitmap(await response.blob());
      let blob: Blob;
      try {
        blob = await encodeCanvas(drawEditedImage(image, edit.rotation, edit.crop), imageMimeType(descriptor.fileName));
      } finally {
        image.close();
      }
      await writeBytes(descriptor.sessionId, new Uint8Array(await blob.arrayBuffer()));
      setEdit(null);
      onSaved(blob);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
      throw reason;
    } finally {
      setSaving(false);
    }
  }, [descriptor.fileName, descriptor.sessionId, dirty, edit, onSaved, saving, sourceUrl, writeBytes]);

  usePreviewUnsaved(host, dirty, save);

  const actions = h(React.Fragment, null,
    h(ImageEditButton, { label: tPreview('image.rotateLeft'), icon: ImageRotateLeftIcon, onClick: () => turn(-1) }),
    h(ImageEditButton, { label: tPreview('image.rotateRight'), icon: ImageRotateRightIcon, onClick: () => turn(1) }),
    h(ImageEditButton, { label: tPreview('image.crop'), icon: ImageCropIcon, pressed: !!edit?.crop, onClick: toggleCrop }),
    h(ImageEditButton, { label: tPreview('image.discardEdit'), icon: DocumentDiscardIcon, disabled: !dirty || saving, onClick: discard }),
    h(ImageEditButton, {
      label: saving ? tPreview('chrome.saving') : tPreview('chrome.save'),
      icon: DocumentSaveIcon,
      disabled: !dirty || saving,
      onClick: () => { if (host?.requestHostSave) host.requestHostSave(); else void save(); },
    }),
  );

  const overlay = edit
    ? h(ImageEditLayer, {
        viewerRef,
        rotation: edit.rotation,
        crop: edit.crop,
        error,
        onCrop: (crop: ImageCropRect) => setEdit((current) => current && { ...current, crop }),
      })
    : null;

  return { actions, overlay };
}

/** Lives inside the image frame: turns the viewer's picture and draws the crop box over it. */
function ImageEditLayer(props: {
  viewerRef: React.RefObject<FileViewerHandle | null>;
  rotation: ImageRotation;
  crop: ImageCropRect | null;
  error: string | null;
  onCrop: (crop: ImageCropRect) => void;
}): React.ReactElement {
  const { viewerRef, rotation, crop, error, onCrop } = props;
  const layerRef = React.useRef<HTMLDivElement>(null);
  const drag = React.useRef<{ handle: CropHandle; start: ImageCropRect; x: number; y: number } | null>(null);
  const [natural, setNatural] = React.useState<{ width: number; height: number } | null>(null);

  React.useLayoutEffect(() => {
    const picture = layerRef.current?.parentElement?.querySelector('img');
    if (picture?.naturalWidth) setNatural({ width: picture.naturalWidth, height: picture.naturalHeight });
  }, []);
  React.useEffect(() => {
    void viewerRef.current?.applyViewState({ rotation });
  }, [viewerRef, rotation]);
  React.useEffect(() => () => {
    void viewerRef.current?.applyViewState({ rotation: 0 });
  }, [viewerRef]);

  const turned = natural ? rotatedSize(natural.width, natural.height, rotation) : null;
  const cropSize = crop && turned ? cropPixels(crop, turned.width, turned.height) : null;

  const onCropPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!crop || event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget.setPointerCapture(event.pointerId);
    const handle = (event.target as HTMLElement).dataset.handle as CropHandle | undefined;
    drag.current = { handle: handle ?? 'move', start: crop, x: event.clientX, y: event.clientY };
  };
  const onCropPointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const current = drag.current;
    const layer = layerRef.current;
    if (!current || !layer) return;
    onCrop(dragCropRect(current.start, current.handle, (event.clientX - current.x) / layer.clientWidth, (event.clientY - current.y) / layer.clientHeight));
  };
  const endDrag = () => { drag.current = null; };

  return h('div', { ref: layerRef, className: 'preview-image-edit-layer', 'data-cropping': crop ? '' : undefined },
    crop
      ? h('div', { className: 'preview-image-crop-clip', onClick: (event: React.MouseEvent) => event.stopPropagation() },
          h('div', {
            className: 'preview-image-crop',
            style: { left: `${crop.x * 100}%`, top: `${crop.y * 100}%`, width: `${crop.width * 100}%`, height: `${crop.height * 100}%` },
            onPointerDown: onCropPointerDown,
            onPointerMove: onCropPointerMove,
            onPointerUp: endDrag,
            onPointerCancel: endDrag,
          },
            ...HANDLES.map((handle) => h('span', { key: handle, className: 'preview-image-crop-handle', 'data-handle': handle })),
            cropSize ? h('span', { key: 'size', className: 'preview-image-crop-size' }, `${cropSize.width} × ${cropSize.height}`) : null,
          ))
      : null,
    error ? h('div', { className: 'preview-image-edit-error', role: 'alert' }, error) : null,
  );
}
