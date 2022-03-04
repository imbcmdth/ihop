import ProxyHandler from './proxy-handler';
import isStructuredCloneable from './is-structured-cloneable';

const noop = () => {};

export default class Reflector {
  constructor(router, proxySchema, retainedStore) {
    this.router = router;
    this.proxySchema = proxySchema;
    this.retainedStore = retainedStore;

    this.router.on('get', (message) => this.onGet(message));
    this.router.on('set', (message) => this.onSet(message));
    this.router.on('call', (message) => this.onCall(message));
  }

  doReturn (message, value, error) {
    const { source, promiseId} = message;

    if (!isStructuredCloneable(value)) {
      value = this.proxySchema.toSchema(value);
    }

    this.router.route({
      type: 'return',
      destination: source,
      value,
      error,
      from: this.router.name,
      source: this.router.path,
      promiseId
    });
  }

  async onGet(message) {
    const {targetName, property } = message;

    try {
      //const propertyPath = property.split('.');
      const target = this.retainedStore.get(targetName);

      if (!target) {
        return this.doReturn(message, undefined);
      }

      const value = await Reflect.get(target, property);

      this.doReturn(message, value);
    } catch (error) {
      this.doReturn(message, undefined, error);
    }
  }

  async onCall(message) {
    const {targetName, args, source } = message;
    // if any arguments are functions - ie. callbacks:
    // 1) get the remote function id
    // 2) generate proxy function that calls to that id
    // 3) replace parameter with proxy

    try {
      const newArgs = args.map((arg) => {
        if (!this.proxySchema.isSchema(arg)){
          return arg;
        }

        // Finalization needs to be tracked so the references can be
        // deleted at the "source" node
        const proxy = this.proxySchema.fromSchema(arg, source, true);

        // this.finalizationRegistry.register(proxy, {
        //   destination: source,
        //   retainedId
        // });

        return proxy;
      });

      const target = this.retainedStore.get(targetName);
      if (!target) {
        return this.doReturn(message, undefined);
      }

      const value = await Reflect.apply(target, undefined, newArgs);

      // if value is complex (not cloneable):
      // retain it and generate a proxy schema for it
      // send schema as value

      this.doReturn(message, value);
    } catch (error) {
      this.doReturn(message, undefined, error);
    }
  }

  async onSet(message) {
    const {targetName, property, value } = message;

    try {
      const target = this.retainedStore.get(targetName);

      if (!target) {
        return this.doReturn(message, undefined);
      }

      Reflect.set(target, property, value);
      this.doReturn(message, value);
    } catch (error) {
      this.doReturn(message, undefined, error);
    }
  }
}