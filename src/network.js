import EventEmitter from 'eventemitter3';
import { nanoid } from 'nanoid';

import sameOrigin from './same.js';
import { IHOP_VERSION, IHOP_MAJOR_VERSION, IHOP_MINOR_VERSION } from './constants.js';
import { Packr } from 'msgpackr';

let packr = new Packr();

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

class WorkerNode extends Node {
  constructor(id, window, origin) {
    super(id, window, origin);
  }
  send(message) {
    if (this.window) {
      this.window.postMessage(message);
    }
  }
}

/**
 * Network - security for cross-origin message passing
 */
export default class Network extends EventEmitter {
  constructor(global, options = {}) {
    super();
    this.global = global;
    this.nodes_ = new Map(/* <uuid, Node> */);
    this.sourceToId_ = new WeakMap(/* <window, uuid> */);

    this.buildOptions_(options);
    this.setupAllowedOrigins_();
    this.setupParentNode_();

    // Setup message pump
    this.global.addEventListener('message', (...args) => this.onMessage(...args));
  }

  buildOptions_(options) {
    const isWindowRoot = (!this.global || this.global.parent === this.global);

    this.options = Object.assign({}, {
      parentOrigin: '*',
      parentWindow: isWindowRoot ? null : this.global.parent,
      allowedOrigins: [],
    }, options);
  }

  setupAllowedOrigins_() {
    this.allowedOrigins_ = this.options.allowedOrigins.slice();

    if (this.options.parentOrigin !== '*') {
      this.allowedOrigins_.push(this.options.parentOrigin);
    }
  }

  setupParentNode_(){
    if (this.options.parentWindow) {
      this.parentId_ = nanoid();

      let parentNode;

      if (this.global['WorkerGlobalScope'] && this.global instanceof this.global['WorkerGlobalScope']) {
        parentNode = new WorkerNode(this.parentId_, this.options.parentWindow, this.options.parentOrigin);
      } else {
        parentNode = new Node(this.parentId_, this.options.parentWindow, this.options.parentOrigin);
      }

      this.nodes_.set(this.parentId_, parentNode);
      this.sourceToId_.set(this.options.parentWindow, this.parentId_);
    }
  }

  ihopMessage_(data) {
    const encodedData = packr.pack(data);

    return {
      version: IHOP_VERSION,
      data: encodedData
    };
  }

  registerWorker(worker) {
    const workerId = nanoid();
    const workerNode = new WorkerNode(workerId, worker, '*');

    this.nodes_.set(workerId, workerNode);
    this.sourceToId_.set(worker, workerId);

    worker.addEventListener('message', (...args) => this.onMessage(...args));
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
    const { origin, srcElement, data } = message;
    let { source } = message;
    const { allowedOrigins } = this.options_;

    if (!source) {
      source = srcElement;
    }

    if (!data || !data.data || !source) {
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
      console.error('Received a message from an incompatible IHop version', version, 'expecting', IHOP_VERSION);
      return;
    } else if (minor !== IHOP_MINOR_VERSION) {
      console.warn('Received a message from a different IHop version', version, 'expecting', IHOP_VERSION);
    }

    let sourceId;

    // Register this node if we have never seen it before...
    if (source !== this.global && !this.sourceToId_.has(source)) {
      sourceId = nanoid();
      const node = new Node(sourceId, source, origin);

      this.nodes_.set(sourceId, node);
      this.sourceToId_.set(source, sourceId);
    } else {
      sourceId = this.sourceToId_.get(source);
    }
    const decodedData = packr.unpack(data.data);
    const newMessage = Object.assign({}, decodedData, {
      nodeId: sourceId,
    });

    this.emit('message', newMessage);
  }
}
