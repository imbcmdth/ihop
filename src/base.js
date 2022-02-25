import sameOrigin from 'same-origin';

import NetworkController from './network';
import IHOPChild from './child';
import { IHOP_VERSION, IHOP_MAJOR_VERSION, IHOP_MINOR_VERSION } from './constants';

const defaultOptions = {
  forceRoot: false
};

/**
 * Iframe Hopper Base - contains the functionality related to maintaining a
 * globally consistent state between iframes.
 */
export default class IHOPBase extends EventTarget {
  constructor(name, options = {}) {
    super();
    this.name = name;
    this.path = '';
    this.options_ = Object.assign({}, defaultOptions, options);

    this.childTreeVersions_ = new Map();
    this.localTreeVersion_ = 1;
    this.globalTreeVersion_ = 0;

    // For the root node, localTree and globalTree are identical
    this.localTree_ = {};
    this.globalTree_ = {};

    // We are assumed to be a root until we know otherwise (ie. receive a poke back
    // from our parent)
    this.isRoot = true;

    this.network = new NetworkController(this.options_);

    if (window.parent !== window && this.options_.forceRoot === false) {
      this.registerWithParent_();
    } else {
      // TODO: Hmmm
      this.network.parent_ = null;
    }

    this.network.on('peek', this.onPeek.bind(this));
    this.network.on('poke', this.onPoke.bind(this));
  }

  registerWithParent_() {
    // Periodically, peek parent until we get a poke back then stop
    this.parentPing_ = setInterval(()=> this.peekState_(), 1000);

    this.peekState_();
  }

  notRootAnymore_() {
    this.isRoot = false;
    clearInterval(this.parentPing_);
  }

  generatePath(base, part) {
    return base.length ? `${base}.${part}` : part;
  }

  generateProxies() {}

  peekState_() {
    this.network.toParent({
      type: 'peek',
      version: this.localTreeVersion_,
      from: this.name,
      state: this.localTree_
    });
  }

  pokeState_() {
    this.network.toAllChildren({
      type: 'poke',
      path: this.path,
      version: this.globalTreeVersion_,
      state: this.globalTree_
    });
  }

  /**
   * Handles the event type "peek" used by non-root elements to signal their parents that their local state has changed
   * @param  {object} data - The event payload
   * @param  {window} eventSource - The source window the event originated from
   */
  onPeek(data, eventSource, eventOrigin) {
    const {from, state, version} = data;

    // If we didn't know this child exists...
    if (!this.childTreeVersions_.has(from)) {
      this.childTreeVersions_.set(from, 0);
    }

    const childStateVersion = this.childTreeVersions_.get(from);

    if (version > childStateVersion) {
      this.childTreeVersions_.set(from, version);
      this.localTree_[from] = state;
      this.localTreeVersion_ = Math.max(version, this.localTreeVersion_) + 1;

      if (this.isRoot) {
        // Start poking to send global state down the tree
        this.globalTree_ = this.localTree_;
        this.globalTreeVersion_ = this.localTreeVersion_;
        this.generateProxies();
        this.pokeState_();
      }

      // Continue propagating upwards
      // We do this even if we are root because we can't be sure if our
      // parent node just hasn't responded yet
      this.peekState_();
    }
  }

  /**
   * Handles the event type "poke" used to send the global state down the tree from the root node
   * @param  {object} data - The event payload
   * @param  {window} eventSource - The source window the event originated from
   */
  onPoke(data) {
    const {state, version, path} = data;

    // If we get a poke from our parent, we know we are no longer a root node
    if (this.isRoot) {
      this.notRootAnymore_();
    }

    if (version > this.globalTreeVersion_) {
      this.globalTree_ = state;
      this.path = this.generatePath(path, this.name);
      this.globalTreeVersion_ = version;
      this.generateProxies();

      // Continue propagating downwards
      this.pokeState_();
    }
  }
}
