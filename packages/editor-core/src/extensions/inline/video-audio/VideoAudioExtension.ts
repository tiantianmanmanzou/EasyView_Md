/**
 * VideoAudioExtension
 *
 * Auto-detects video/audio files from image syntax ![alt](file.mp4)
 * and renders them as native <video>/<audio> elements with controls.
 * Serializes back to standard image markdown syntax for GitLab compatibility.
 */

import type { NodeViewConstructor, EditorView } from 'prosemirror-view';
import type { NodeSpec, Node as ProsemirrorNode } from 'prosemirror-model';
import {
  Extension,
  type SerializerNodeHandler,
} from '../../../editor/EditorExtension';

export class VideoAudioExtension extends Extension {
  get name() {
    return 'video-audio';
  }

  get nodeViews(): Record<string, NodeViewConstructor> {
    return {
      video: (node, view, getPos) => createVideoNodeView(node, view),
      audio: (node, view, getPos) => createAudioNodeView(node, view),
    };
  }
}

// ─── Video NodeView ─────────────────────────────────────────────────────────

function createVideoNodeView(node: ProsemirrorNode, _view: EditorView) {
  const dom = document.createElement('span');
  dom.className = 'video-embed';

  const video = document.createElement('video');
  video.src = node.attrs.src || '';
  video.controls = true;
  video.title = node.attrs.alt || node.attrs.title || '';
  if (node.attrs.alt) video.setAttribute('data-alt', node.attrs.alt);
  dom.appendChild(video);

  return {
    dom,
    update(updatedNode: ProsemirrorNode) {
      if (updatedNode.type.name !== 'video') return false;
      video.src = updatedNode.attrs.src || '';
      video.title = updatedNode.attrs.alt || updatedNode.attrs.title || '';
      return true;
    },
    stopEvent(e: Event) {
      // Let video controls work normally
      return e.target === video;
    },
    ignoreMutation() {
      return true;
    },
  };
}

// ─── Audio NodeView ─────────────────────────────────────────────────────────

function createAudioNodeView(node: ProsemirrorNode, _view: EditorView) {
  const dom = document.createElement('span');
  dom.className = 'audio-embed';

  const audio = document.createElement('audio');
  audio.src = node.attrs.src || '';
  audio.controls = true;
  audio.title = node.attrs.alt || node.attrs.title || '';
  if (node.attrs.alt) audio.setAttribute('data-alt', node.attrs.alt);
  dom.appendChild(audio);

  return {
    dom,
    update(updatedNode: ProsemirrorNode) {
      if (updatedNode.type.name !== 'audio') return false;
      audio.src = updatedNode.attrs.src || '';
      audio.title = updatedNode.attrs.alt || updatedNode.attrs.title || '';
      return true;
    },
    stopEvent(e: Event) {
      return e.target === audio;
    },
    ignoreMutation() {
      return true;
    },
  };
}
