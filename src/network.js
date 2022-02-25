import sameOrigin from 'same-origin';
import EventEmitter from 'eventemitter3';
import { nanoid } from 'nanoid';
import { IHOP_VERSION, IHOP_MAJOR_VERSION, IHOP_MINOR_VERSION } from './constants';

const defaultOptions = {
  parentOrigin: '*',
  allowedOrigins: [],
  parentWindow: (window.parent !== window) ? window.parent : null,
};

class Node {
  constructor(id, window, origin) {
    this.id = id;
    this.origin = origin;
    this.window = window;
  }
  send(message) {
    if (this.window) {
      this.window.postMessage(message, this.origin);
    }
  }
}

/**
 * Iframe Hopper Base - contains the functionality related to maintaining a
 * globally consistent state between iframes.
 */
export default class NetworkAdapter extends EventEmitter {
  constructor(options = {}) {
    super();
    const finalOptions = Object.assign({}, defaultOptions, options);

    this.nodes_ = new Map(/* <uuid, Node> */);
    this.sourceToId_ = new WeakMap(/* <window, uuid> */);
    this.allowedOrigins_ = finalOptions.allowedOrigins.slice();
    if (finalOptions.parentOrigin !== '*') {
      this.allowedOrigins_.push(finalOptions.parentOrigin);
    }

    // Setup message pump
    window.addEventListener('message', (...args) => this.onMessage(...args));

    if (finalOptions.parentWindow) {
      this.parentId_ = nanoid();
      const parentNode = new Node(this.parentId_, finalOptions.parentWindow, finalOptions.parentOrigin);
      this.nodes_.set(this.parentId_, parentNode);
      this.sourceToId_.set(finalOptions.parentWindow, this.parentId_);
    }
  }

  ihopMessage_(data) {
    return {
      version: IHOP_VERSION,
      data
    };
  }

  toNode(nodeId, message) {
    const ihopMessage = this.ihopMessage_(message);
    const node = this.nodes_.get(nodeId);

    if (node) {
      this.nodes_.get(nodeId).send(ihopMessage);
    }
  }

  toParent(message) {
    this.toNode(this.parentId_, message);
  }

  toAllChildren(message) {
    const ihopMessage = this.ihopMessage_(message);

    for (let nodeId of this.nodes_.keys()) {
      if (nodeId !== this.parentId_) {
        const node = this.nodes_.get(nodeId);
        if (node) {
          node.send(ihopMessage);
        }
      }
    }
  }

  isAllowedOrigin_ (origin) {
    return this.allowedOrigins_.some((allowedOrigin) => sameOrigin(allowedOrigin, origin));
  }

  /**
   * Handles all events and forwards them to a matching `on*` handler defined in this class
   * @param  {object} data - The event payload
   * @param  {window} eventSource - The source window the event originated from
   */
  onMessage(message) {
    const { origin, source, data } = message;
    const { allowedOrigins } = this.options_;

    if (!data || !data.data) {
      return;
    }

    // If the message is not from an allowed origin throw it out before any
    // further processing.
    if (this.allowedOrigins_.length && !this.isAllowedOrigin_(origin)) {
      return;
    }

    const { version } = data;

    if (!version) {
      return;
    }

    const [major, minor] = version.split('.');

    if (major !== IHOP_MAJOR_VERSION) {
      console.error('Received a message from an incompatible IHOP version', version, 'expecting', IHOP_VERSION);
      return;
    } else if (minor !== IHOP_MINOR_VERSION) {
      console.warn('Received a message from a different IHOP version', version, 'expecting', IHOP_VERSION);
    }

    let sourceId;

    // Register this node if we have never seen it before...
    if (!this.sourceToId_.has(source)) {
      sourceId = nanoid();
      const node = new Node(sourceId, source, origin);

      this.nodes_.set(sourceId, node);
      this.sourceToId_.set(source, node);
    } else {
      sourceId = this.sourceToId_.get(source);
    }

    const newMessage = Object.assign({}, data.data, {
      nodeId: sourceId,
    });

    console.debug('what>>', newMessage.type, 'from>>', newMessage.from,'data>>', newMessage);

    this.emit('message', newMessage);
  }
}
