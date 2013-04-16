
/** vim: et:ts=4:sw=4:sts=4
 * @license RequireJS 2.1.5 Copyright (c) 2010-2012, The Dojo Foundation All Rights Reserved.
 * Available via the MIT or new BSD license.
 * see: http://github.com/jrburke/requirejs for details
 */
//Not using strict: uneven strict support in browsers, #392, and causes
//problems with requirejs.exec()/transpiler plugins that may not be strict.
/*jslint regexp: true, nomen: true, sloppy: true */
/*global window, navigator, document, importScripts, setTimeout, opera */

var requirejs, require, define;
(function (global) {
    var req, s, head, baseElement, dataMain, src,
        interactiveScript, currentlyAddingScript, mainScript, subPath,
        version = '2.1.5',
        commentRegExp = /(\/\*([\s\S]*?)\*\/|([^:]|^)\/\/(.*)$)/mg,
        cjsRequireRegExp = /[^.]\s*require\s*\(\s*["']([^'"\s]+)["']\s*\)/g,
        jsSuffixRegExp = /\.js$/,
        currDirRegExp = /^\.\//,
        op = Object.prototype,
        ostring = op.toString,
        hasOwn = op.hasOwnProperty,
        ap = Array.prototype,
        apsp = ap.splice,
        isBrowser = !!(typeof window !== 'undefined' && navigator && document),
        isWebWorker = !isBrowser && typeof importScripts !== 'undefined',
    //PS3 indicates loaded and complete, but need to wait for complete
    //specifically. Sequence is 'loading', 'loaded', execution,
    // then 'complete'. The UA check is unfortunate, but not sure how
    //to feature test w/o causing perf issues.
        readyRegExp = isBrowser && navigator.platform === 'PLAYSTATION 3' ?
            /^complete$/ : /^(complete|loaded)$/,
        defContextName = '_',
    //Oh the tragedy, detecting opera. See the usage of isOpera for reason.
        isOpera = typeof opera !== 'undefined' && opera.toString() === '[object Opera]',
        contexts = {},
        cfg = {},
        globalDefQueue = [],
        useInteractive = false;

    function isFunction(it) {
        return ostring.call(it) === '[object Function]';
    }

    function isArray(it) {
        return ostring.call(it) === '[object Array]';
    }

    /**
     * Helper function for iterating over an array. If the func returns
     * a true value, it will break out of the loop.
     */
    function each(ary, func) {
        if (ary) {
            var i;
            for (i = 0; i < ary.length; i += 1) {
                if (ary[i] && func(ary[i], i, ary)) {
                    break;
                }
            }
        }
    }

    /**
     * Helper function for iterating over an array backwards. If the func
     * returns a true value, it will break out of the loop.
     */
    function eachReverse(ary, func) {
        if (ary) {
            var i;
            for (i = ary.length - 1; i > -1; i -= 1) {
                if (ary[i] && func(ary[i], i, ary)) {
                    break;
                }
            }
        }
    }

    function hasProp(obj, prop) {
        return hasOwn.call(obj, prop);
    }

    function getOwn(obj, prop) {
        return hasProp(obj, prop) && obj[prop];
    }

    /**
     * Cycles over properties in an object and calls a function for each
     * property value. If the function returns a truthy value, then the
     * iteration is stopped.
     */
    function eachProp(obj, func) {
        var prop;
        for (prop in obj) {
            if (hasProp(obj, prop)) {
                if (func(obj[prop], prop)) {
                    break;
                }
            }
        }
    }

    /**
     * Simple function to mix in properties from source into target,
     * but only if target does not already have a property of the same name.
     */
    function mixin(target, source, force, deepStringMixin) {
        if (source) {
            eachProp(source, function (value, prop) {
                if (force || !hasProp(target, prop)) {
                    if (deepStringMixin && typeof value !== 'string') {
                        if (!target[prop]) {
                            target[prop] = {};
                        }
                        mixin(target[prop], value, force, deepStringMixin);
                    } else {
                        target[prop] = value;
                    }
                }
            });
        }
        return target;
    }

    //Similar to Function.prototype.bind, but the 'this' object is specified
    //first, since it is easier to read/figure out what 'this' will be.
    function bind(obj, fn) {
        return function () {
            return fn.apply(obj, arguments);
        };
    }

    function scripts() {
        return document.getElementsByTagName('script');
    }

    //Allow getting a global that expressed in
    //dot notation, like 'a.b.c'.
    function getGlobal(value) {
        if (!value) {
            return value;
        }
        var g = global;
        each(value.split('.'), function (part) {
            g = g[part];
        });
        return g;
    }

    /**
     * Constructs an error with a pointer to an URL with more information.
     * @param {String} id the error ID that maps to an ID on a web page.
     * @param {String} message human readable error.
     * @param {Error} [err] the original error, if there is one.
     *
     * @returns {Error}
     */
    function makeError(id, msg, err, requireModules) {
        var e = new Error(msg + '\nhttp://requirejs.org/docs/errors.html#' + id);
        e.requireType = id;
        e.requireModules = requireModules;
        if (err) {
            e.originalError = err;
        }
        return e;
    }

    if (typeof define !== 'undefined') {
        //If a define is already in play via another AMD loader,
        //do not overwrite.
        return;
    }

    if (typeof requirejs !== 'undefined') {
        if (isFunction(requirejs)) {
            //Do not overwrite and existing requirejs instance.
            return;
        }
        cfg = requirejs;
        requirejs = undefined;
    }

    //Allow for a require config object
    if (typeof require !== 'undefined' && !isFunction(require)) {
        //assume it is a config object.
        cfg = require;
        require = undefined;
    }

    function newContext(contextName) {
        var inCheckLoaded, Module, context, handlers,
            checkLoadedTimeoutId,
            config = {
                //Defaults. Do not set a default for map
                //config to speed up normalize(), which
                //will run faster if there is no default.
                waitSeconds: 7,
                baseUrl: './',
                paths: {},
                pkgs: {},
                shim: {},
                config: {}
            },
            registry = {},
        //registry of just enabled modules, to speed
        //cycle breaking code when lots of modules
        //are registered, but not activated.
            enabledRegistry = {},
            undefEvents = {},
            defQueue = [],
            defined = {},
            urlFetched = {},
            requireCounter = 1,
            unnormalizedCounter = 1;

        /**
         * Trims the . and .. from an array of path segments.
         * It will keep a leading path segment if a .. will become
         * the first path segment, to help with module name lookups,
         * which act like paths, but can be remapped. But the end result,
         * all paths that use this function should look normalized.
         * NOTE: this method MODIFIES the input array.
         * @param {Array} ary the array of path segments.
         */
        function trimDots(ary) {
            var i, part;
            for (i = 0; ary[i]; i += 1) {
                part = ary[i];
                if (part === '.') {
                    ary.splice(i, 1);
                    i -= 1;
                } else if (part === '..') {
                    if (i === 1 && (ary[2] === '..' || ary[0] === '..')) {
                        //End of the line. Keep at least one non-dot
                        //path segment at the front so it can be mapped
                        //correctly to disk. Otherwise, there is likely
                        //no path mapping for a path starting with '..'.
                        //This can still fail, but catches the most reasonable
                        //uses of ..
                        break;
                    } else if (i > 0) {
                        ary.splice(i - 1, 2);
                        i -= 2;
                    }
                }
            }
        }

        /**
         * Given a relative module name, like ./something, normalize it to
         * a real name that can be mapped to a path.
         * @param {String} name the relative name
         * @param {String} baseName a real name that the name arg is relative
         * to.
         * @param {Boolean} applyMap apply the map config to the value. Should
         * only be done if this normalization is for a dependency ID.
         * @returns {String} normalized name
         */
        function normalize(name, baseName, applyMap) {
            var pkgName, pkgConfig, mapValue, nameParts, i, j, nameSegment,
                foundMap, foundI, foundStarMap, starI,
                baseParts = baseName && baseName.split('/'),
                normalizedBaseParts = baseParts,
                map = config.map,
                starMap = map && map['*'];

            //Adjust any relative paths.
            if (name && name.charAt(0) === '.') {
                //If have a base name, try to normalize against it,
                //otherwise, assume it is a top-level require that will
                //be relative to baseUrl in the end.
                if (baseName) {
                    if (getOwn(config.pkgs, baseName)) {
                        //If the baseName is a package name, then just treat it as one
                        //name to concat the name with.
                        normalizedBaseParts = baseParts = [baseName];
                    } else {
                        //Convert baseName to array, and lop off the last part,
                        //so that . matches that 'directory' and not name of the baseName's
                        //module. For instance, baseName of 'one/two/three', maps to
                        //'one/two/three.js', but we want the directory, 'one/two' for
                        //this normalization.
                        normalizedBaseParts = baseParts.slice(0, baseParts.length - 1);
                    }

                    name = normalizedBaseParts.concat(name.split('/'));
                    trimDots(name);

                    //Some use of packages may use a . path to reference the
                    //'main' module name, so normalize for that.
                    pkgConfig = getOwn(config.pkgs, (pkgName = name[0]));
                    name = name.join('/');
                    if (pkgConfig && name === pkgName + '/' + pkgConfig.main) {
                        name = pkgName;
                    }
                } else if (name.indexOf('./') === 0) {
                    // No baseName, so this is ID is resolved relative
                    // to baseUrl, pull off the leading dot.
                    name = name.substring(2);
                }
            }

            //Apply map config if available.
            if (applyMap && map && (baseParts || starMap)) {
                nameParts = name.split('/');

                for (i = nameParts.length; i > 0; i -= 1) {
                    nameSegment = nameParts.slice(0, i).join('/');

                    if (baseParts) {
                        //Find the longest baseName segment match in the config.
                        //So, do joins on the biggest to smallest lengths of baseParts.
                        for (j = baseParts.length; j > 0; j -= 1) {
                            mapValue = getOwn(map, baseParts.slice(0, j).join('/'));

                            //baseName segment has config, find if it has one for
                            //this name.
                            if (mapValue) {
                                mapValue = getOwn(mapValue, nameSegment);
                                if (mapValue) {
                                    //Match, update name to the new value.
                                    foundMap = mapValue;
                                    foundI = i;
                                    break;
                                }
                            }
                        }
                    }

                    if (foundMap) {
                        break;
                    }

                    //Check for a star map match, but just hold on to it,
                    //if there is a shorter segment match later in a matching
                    //config, then favor over this star map.
                    if (!foundStarMap && starMap && getOwn(starMap, nameSegment)) {
                        foundStarMap = getOwn(starMap, nameSegment);
                        starI = i;
                    }
                }

                if (!foundMap && foundStarMap) {
                    foundMap = foundStarMap;
                    foundI = starI;
                }

                if (foundMap) {
                    nameParts.splice(0, foundI, foundMap);
                    name = nameParts.join('/');
                }
            }

            return name;
        }

        function removeScript(name) {
            if (isBrowser) {
                each(scripts(), function (scriptNode) {
                    if (scriptNode.getAttribute('data-requiremodule') === name &&
                        scriptNode.getAttribute('data-requirecontext') === context.contextName) {
                        scriptNode.parentNode.removeChild(scriptNode);
                        return true;
                    }
                });
            }
        }

        function hasPathFallback(id) {
            var pathConfig = getOwn(config.paths, id);
            if (pathConfig && isArray(pathConfig) && pathConfig.length > 1) {
                removeScript(id);
                //Pop off the first array value, since it failed, and
                //retry
                pathConfig.shift();
                context.require.undef(id);
                context.require([id]);
                return true;
            }
        }

        //Turns a plugin!resource to [plugin, resource]
        //with the plugin being undefined if the name
        //did not have a plugin prefix.
        function splitPrefix(name) {
            var prefix,
                index = name ? name.indexOf('!') : -1;
            if (index > -1) {
                prefix = name.substring(0, index);
                name = name.substring(index + 1, name.length);
            }
            return [prefix, name];
        }

        /**
         * Creates a module mapping that includes plugin prefix, module
         * name, and path. If parentModuleMap is provided it will
         * also normalize the name via require.normalize()
         *
         * @param {String} name the module name
         * @param {String} [parentModuleMap] parent module map
         * for the module name, used to resolve relative names.
         * @param {Boolean} isNormalized: is the ID already normalized.
         * This is true if this call is done for a define() module ID.
         * @param {Boolean} applyMap: apply the map config to the ID.
         * Should only be true if this map is for a dependency.
         *
         * @returns {Object}
         */
        function makeModuleMap(name, parentModuleMap, isNormalized, applyMap) {
            var url, pluginModule, suffix, nameParts,
                prefix = null,
                parentName = parentModuleMap ? parentModuleMap.name : null,
                originalName = name,
                isDefine = true,
                normalizedName = '';

            //If no name, then it means it is a require call, generate an
            //internal name.
            if (!name) {
                isDefine = false;
                name = '_@r' + (requireCounter += 1);
            }

            nameParts = splitPrefix(name);
            prefix = nameParts[0];
            name = nameParts[1];

            if (prefix) {
                prefix = normalize(prefix, parentName, applyMap);
                pluginModule = getOwn(defined, prefix);
            }

            //Account for relative paths if there is a base name.
            if (name) {
                if (prefix) {
                    if (pluginModule && pluginModule.normalize) {
                        //Plugin is loaded, use its normalize method.
                        normalizedName = pluginModule.normalize(name, function (name) {
                            return normalize(name, parentName, applyMap);
                        });
                    } else {
                        normalizedName = normalize(name, parentName, applyMap);
                    }
                } else {
                    //A regular module.
                    normalizedName = normalize(name, parentName, applyMap);

                    //Normalized name may be a plugin ID due to map config
                    //application in normalize. The map config values must
                    //already be normalized, so do not need to redo that part.
                    nameParts = splitPrefix(normalizedName);
                    prefix = nameParts[0];
                    normalizedName = nameParts[1];
                    isNormalized = true;

                    url = context.nameToUrl(normalizedName);
                }
            }

            //If the id is a plugin id that cannot be determined if it needs
            //normalization, stamp it with a unique ID so two matching relative
            //ids that may conflict can be separate.
            suffix = prefix && !pluginModule && !isNormalized ?
                '_unnormalized' + (unnormalizedCounter += 1) :
                '';

            return {
                prefix: prefix,
                name: normalizedName,
                parentMap: parentModuleMap,
                unnormalized: !!suffix,
                url: url,
                originalName: originalName,
                isDefine: isDefine,
                id: (prefix ?
                    prefix + '!' + normalizedName :
                    normalizedName) + suffix
            };
        }

        function getModule(depMap) {
            var id = depMap.id,
                mod = getOwn(registry, id);

            if (!mod) {
                mod = registry[id] = new context.Module(depMap);
            }

            return mod;
        }

        function on(depMap, name, fn) {
            var id = depMap.id,
                mod = getOwn(registry, id);

            if (hasProp(defined, id) &&
                (!mod || mod.defineEmitComplete)) {
                if (name === 'defined') {
                    fn(defined[id]);
                }
            } else {
                getModule(depMap).on(name, fn);
            }
        }

        function onError(err, errback) {
            var ids = err.requireModules,
                notified = false;

            if (errback) {
                errback(err);
            } else {
                each(ids, function (id) {
                    var mod = getOwn(registry, id);
                    if (mod) {
                        //Set error on module, so it skips timeout checks.
                        mod.error = err;
                        if (mod.events.error) {
                            notified = true;
                            mod.emit('error', err);
                        }
                    }
                });

                if (!notified) {
                    req.onError(err);
                }
            }
        }

        /**
         * Internal method to transfer globalQueue items to this context's
         * defQueue.
         */
        function takeGlobalQueue() {
            //Push all the globalDefQueue items into the context's defQueue
            if (globalDefQueue.length) {
                //Array splice in the values since the context code has a
                //local var ref to defQueue, so cannot just reassign the one
                //on context.
                apsp.apply(defQueue,
                    [defQueue.length - 1, 0].concat(globalDefQueue));
                globalDefQueue = [];
            }
        }

        handlers = {
            'require': function (mod) {
                if (mod.require) {
                    return mod.require;
                } else {
                    return (mod.require = context.makeRequire(mod.map));
                }
            },
            'exports': function (mod) {
                mod.usingExports = true;
                if (mod.map.isDefine) {
                    if (mod.exports) {
                        return mod.exports;
                    } else {
                        return (mod.exports = defined[mod.map.id] = {});
                    }
                }
            },
            'module': function (mod) {
                if (mod.module) {
                    return mod.module;
                } else {
                    return (mod.module = {
                        id: mod.map.id,
                        uri: mod.map.url,
                        config: function () {
                            return (config.config && getOwn(config.config, mod.map.id)) || {};
                        },
                        exports: defined[mod.map.id]
                    });
                }
            }
        };

        function cleanRegistry(id) {
            //Clean up machinery used for waiting modules.
            delete registry[id];
            delete enabledRegistry[id];
        }

        function breakCycle(mod, traced, processed) {
            var id = mod.map.id;

            if (mod.error) {
                mod.emit('error', mod.error);
            } else {
                traced[id] = true;
                each(mod.depMaps, function (depMap, i) {
                    var depId = depMap.id,
                        dep = getOwn(registry, depId);

                    //Only force things that have not completed
                    //being defined, so still in the registry,
                    //and only if it has not been matched up
                    //in the module already.
                    if (dep && !mod.depMatched[i] && !processed[depId]) {
                        if (getOwn(traced, depId)) {
                            mod.defineDep(i, defined[depId]);
                            mod.check(); //pass false?
                        } else {
                            breakCycle(dep, traced, processed);
                        }
                    }
                });
                processed[id] = true;
            }
        }

        function checkLoaded() {
            var map, modId, err, usingPathFallback,
                waitInterval = config.waitSeconds * 1000,
            //It is possible to disable the wait interval by using waitSeconds of 0.
                expired = waitInterval && (context.startTime + waitInterval) < new Date().getTime(),
                noLoads = [],
                reqCalls = [],
                stillLoading = false,
                needCycleCheck = true;

            //Do not bother if this call was a result of a cycle break.
            if (inCheckLoaded) {
                return;
            }

            inCheckLoaded = true;

            //Figure out the state of all the modules.
            eachProp(enabledRegistry, function (mod) {
                map = mod.map;
                modId = map.id;

                //Skip things that are not enabled or in error state.
                if (!mod.enabled) {
                    return;
                }

                if (!map.isDefine) {
                    reqCalls.push(mod);
                }

                if (!mod.error) {
                    //If the module should be executed, and it has not
                    //been inited and time is up, remember it.
                    if (!mod.inited && expired) {
                        if (hasPathFallback(modId)) {
                            usingPathFallback = true;
                            stillLoading = true;
                        } else {
                            noLoads.push(modId);
                            removeScript(modId);
                        }
                    } else if (!mod.inited && mod.fetched && map.isDefine) {
                        stillLoading = true;
                        if (!map.prefix) {
                            //No reason to keep looking for unfinished
                            //loading. If the only stillLoading is a
                            //plugin resource though, keep going,
                            //because it may be that a plugin resource
                            //is waiting on a non-plugin cycle.
                            return (needCycleCheck = false);
                        }
                    }
                }
            });

            if (expired && noLoads.length) {
                //If wait time expired, throw error of unloaded modules.
                err = makeError('timeout', 'Load timeout for modules: ' + noLoads, null, noLoads);
                err.contextName = context.contextName;
                return onError(err);
            }

            //Not expired, check for a cycle.
            if (needCycleCheck) {
                each(reqCalls, function (mod) {
                    breakCycle(mod, {}, {});
                });
            }

            //If still waiting on loads, and the waiting load is something
            //other than a plugin resource, or there are still outstanding
            //scripts, then just try back later.
            if ((!expired || usingPathFallback) && stillLoading) {
                //Something is still waiting to load. Wait for it, but only
                //if a timeout is not already in effect.
                if ((isBrowser || isWebWorker) && !checkLoadedTimeoutId) {
                    checkLoadedTimeoutId = setTimeout(function () {
                        checkLoadedTimeoutId = 0;
                        checkLoaded();
                    }, 50);
                }
            }

            inCheckLoaded = false;
        }

        Module = function (map) {
            this.events = getOwn(undefEvents, map.id) || {};
            this.map = map;
            this.shim = getOwn(config.shim, map.id);
            this.depExports = [];
            this.depMaps = [];
            this.depMatched = [];
            this.pluginMaps = {};
            this.depCount = 0;

            /* this.exports this.factory
             this.depMaps = [],
             this.enabled, this.fetched
             */
        };

        Module.prototype = {
            init: function (depMaps, factory, errback, options) {
                options = options || {};

                //Do not do more inits if already done. Can happen if there
                //are multiple define calls for the same module. That is not
                //a normal, common case, but it is also not unexpected.
                if (this.inited) {
                    return;
                }

                this.factory = factory;

                if (errback) {
                    //Register for errors on this module.
                    this.on('error', errback);
                } else if (this.events.error) {
                    //If no errback already, but there are error listeners
                    //on this module, set up an errback to pass to the deps.
                    errback = bind(this, function (err) {
                        this.emit('error', err);
                    });
                }

                //Do a copy of the dependency array, so that
                //source inputs are not modified. For example
                //"shim" deps are passed in here directly, and
                //doing a direct modification of the depMaps array
                //would affect that config.
                this.depMaps = depMaps && depMaps.slice(0);

                this.errback = errback;

                //Indicate this module has be initialized
                this.inited = true;

                this.ignore = options.ignore;

                //Could have option to init this module in enabled mode,
                //or could have been previously marked as enabled. However,
                //the dependencies are not known until init is called. So
                //if enabled previously, now trigger dependencies as enabled.
                if (options.enabled || this.enabled) {
                    //Enable this module and dependencies.
                    //Will call this.check()
                    this.enable();
                } else {
                    this.check();
                }
            },

            defineDep: function (i, depExports) {
                //Because of cycles, defined callback for a given
                //export can be called more than once.
                if (!this.depMatched[i]) {
                    this.depMatched[i] = true;
                    this.depCount -= 1;
                    this.depExports[i] = depExports;
                }
            },

            fetch: function () {
                if (this.fetched) {
                    return;
                }
                this.fetched = true;

                context.startTime = (new Date()).getTime();

                var map = this.map;

                //If the manager is for a plugin managed resource,
                //ask the plugin to load it now.
                if (this.shim) {
                    context.makeRequire(this.map, {
                        enableBuildCallback: true
                    })(this.shim.deps || [], bind(this, function () {
                            return map.prefix ? this.callPlugin() : this.load();
                        }));
                } else {
                    //Regular dependency.
                    return map.prefix ? this.callPlugin() : this.load();
                }
            },

            load: function () {
                var url = this.map.url;

                //Regular dependency.
                if (!urlFetched[url]) {
                    urlFetched[url] = true;
                    context.load(this.map.id, url);
                }
            },

            /**
             * Checks if the module is ready to define itself, and if so,
             * define it.
             */
            check: function () {
                if (!this.enabled || this.enabling) {
                    return;
                }

                var err, cjsModule,
                    id = this.map.id,
                    depExports = this.depExports,
                    exports = this.exports,
                    factory = this.factory;

                if (!this.inited) {
                    this.fetch();
                } else if (this.error) {
                    this.emit('error', this.error);
                } else if (!this.defining) {
                    //The factory could trigger another require call
                    //that would result in checking this module to
                    //define itself again. If already in the process
                    //of doing that, skip this work.
                    this.defining = true;

                    if (this.depCount < 1 && !this.defined) {
                        if (isFunction(factory)) {
                            //If there is an error listener, favor passing
                            //to that instead of throwing an error.
                            if (this.events.error) {
                                try {
                                    exports = context.execCb(id, factory, depExports, exports);
                                } catch (e) {
                                    err = e;
                                }
                            } else {
                                exports = context.execCb(id, factory, depExports, exports);
                            }

                            if (this.map.isDefine) {
                                //If setting exports via 'module' is in play,
                                //favor that over return value and exports. After that,
                                //favor a non-undefined return value over exports use.
                                cjsModule = this.module;
                                if (cjsModule &&
                                    cjsModule.exports !== undefined &&
                                    //Make sure it is not already the exports value
                                    cjsModule.exports !== this.exports) {
                                    exports = cjsModule.exports;
                                } else if (exports === undefined && this.usingExports) {
                                    //exports already set the defined value.
                                    exports = this.exports;
                                }
                            }

                            if (err) {
                                err.requireMap = this.map;
                                err.requireModules = [this.map.id];
                                err.requireType = 'define';
                                return onError((this.error = err));
                            }

                        } else {
                            //Just a literal value
                            exports = factory;
                        }

                        this.exports = exports;

                        if (this.map.isDefine && !this.ignore) {
                            defined[id] = exports;

                            if (req.onResourceLoad) {
                                req.onResourceLoad(context, this.map, this.depMaps);
                            }
                        }

                        //Clean up
                        cleanRegistry(id);

                        this.defined = true;
                    }

                    //Finished the define stage. Allow calling check again
                    //to allow define notifications below in the case of a
                    //cycle.
                    this.defining = false;

                    if (this.defined && !this.defineEmitted) {
                        this.defineEmitted = true;
                        this.emit('defined', this.exports);
                        this.defineEmitComplete = true;
                    }

                }
            },

            callPlugin: function () {
                var map = this.map,
                    id = map.id,
                //Map already normalized the prefix.
                    pluginMap = makeModuleMap(map.prefix);

                //Mark this as a dependency for this plugin, so it
                //can be traced for cycles.
                this.depMaps.push(pluginMap);

                on(pluginMap, 'defined', bind(this, function (plugin) {
                    var load, normalizedMap, normalizedMod,
                        name = this.map.name,
                        parentName = this.map.parentMap ? this.map.parentMap.name : null,
                        localRequire = context.makeRequire(map.parentMap, {
                            enableBuildCallback: true
                        });

                    //If current map is not normalized, wait for that
                    //normalized name to load instead of continuing.
                    if (this.map.unnormalized) {
                        //Normalize the ID if the plugin allows it.
                        if (plugin.normalize) {
                            name = plugin.normalize(name, function (name) {
                                return normalize(name, parentName, true);
                            }) || '';
                        }

                        //prefix and name should already be normalized, no need
                        //for applying map config again either.
                        normalizedMap = makeModuleMap(map.prefix + '!' + name,
                            this.map.parentMap);
                        on(normalizedMap,
                            'defined', bind(this, function (value) {
                                this.init([], function () { return value; }, null, {
                                    enabled: true,
                                    ignore: true
                                });
                            }));

                        normalizedMod = getOwn(registry, normalizedMap.id);
                        if (normalizedMod) {
                            //Mark this as a dependency for this plugin, so it
                            //can be traced for cycles.
                            this.depMaps.push(normalizedMap);

                            if (this.events.error) {
                                normalizedMod.on('error', bind(this, function (err) {
                                    this.emit('error', err);
                                }));
                            }
                            normalizedMod.enable();
                        }

                        return;
                    }

                    load = bind(this, function (value) {
                        this.init([], function () { return value; }, null, {
                            enabled: true
                        });
                    });

                    load.error = bind(this, function (err) {
                        this.inited = true;
                        this.error = err;
                        err.requireModules = [id];

                        //Remove temp unnormalized modules for this module,
                        //since they will never be resolved otherwise now.
                        eachProp(registry, function (mod) {
                            if (mod.map.id.indexOf(id + '_unnormalized') === 0) {
                                cleanRegistry(mod.map.id);
                            }
                        });

                        onError(err);
                    });

                    //Allow plugins to load other code without having to know the
                    //context or how to 'complete' the load.
                    load.fromText = bind(this, function (text, textAlt) {
                        /*jslint evil: true */
                        var moduleName = map.name,
                            moduleMap = makeModuleMap(moduleName),
                            hasInteractive = useInteractive;

                        //As of 2.1.0, support just passing the text, to reinforce
                        //fromText only being called once per resource. Still
                        //support old style of passing moduleName but discard
                        //that moduleName in favor of the internal ref.
                        if (textAlt) {
                            text = textAlt;
                        }

                        //Turn off interactive script matching for IE for any define
                        //calls in the text, then turn it back on at the end.
                        if (hasInteractive) {
                            useInteractive = false;
                        }

                        //Prime the system by creating a module instance for
                        //it.
                        getModule(moduleMap);

                        //Transfer any config to this other module.
                        if (hasProp(config.config, id)) {
                            config.config[moduleName] = config.config[id];
                        }

                        try {
                            req.exec(text);
                        } catch (e) {
                            return onError(makeError('fromtexteval',
                                'fromText eval for ' + id +
                                    ' failed: ' + e,
                                e,
                                [id]));
                        }

                        if (hasInteractive) {
                            useInteractive = true;
                        }

                        //Mark this as a dependency for the plugin
                        //resource
                        this.depMaps.push(moduleMap);

                        //Support anonymous modules.
                        context.completeLoad(moduleName);

                        //Bind the value of that module to the value for this
                        //resource ID.
                        localRequire([moduleName], load);
                    });

                    //Use parentName here since the plugin's name is not reliable,
                    //could be some weird string with no path that actually wants to
                    //reference the parentName's path.
                    plugin.load(map.name, localRequire, load, config);
                }));

                context.enable(pluginMap, this);
                this.pluginMaps[pluginMap.id] = pluginMap;
            },

            enable: function () {
                enabledRegistry[this.map.id] = this;
                this.enabled = true;

                //Set flag mentioning that the module is enabling,
                //so that immediate calls to the defined callbacks
                //for dependencies do not trigger inadvertent load
                //with the depCount still being zero.
                this.enabling = true;

                //Enable each dependency
                each(this.depMaps, bind(this, function (depMap, i) {
                    var id, mod, handler;

                    if (typeof depMap === 'string') {
                        //Dependency needs to be converted to a depMap
                        //and wired up to this module.
                        depMap = makeModuleMap(depMap,
                            (this.map.isDefine ? this.map : this.map.parentMap),
                            false,
                            !this.skipMap);
                        this.depMaps[i] = depMap;

                        handler = getOwn(handlers, depMap.id);

                        if (handler) {
                            this.depExports[i] = handler(this);
                            return;
                        }

                        this.depCount += 1;

                        on(depMap, 'defined', bind(this, function (depExports) {
                            this.defineDep(i, depExports);
                            this.check();
                        }));

                        if (this.errback) {
                            on(depMap, 'error', this.errback);
                        }
                    }

                    id = depMap.id;
                    mod = registry[id];

                    //Skip special modules like 'require', 'exports', 'module'
                    //Also, don't call enable if it is already enabled,
                    //important in circular dependency cases.
                    if (!hasProp(handlers, id) && mod && !mod.enabled) {
                        context.enable(depMap, this);
                    }
                }));

                //Enable each plugin that is used in
                //a dependency
                eachProp(this.pluginMaps, bind(this, function (pluginMap) {
                    var mod = getOwn(registry, pluginMap.id);
                    if (mod && !mod.enabled) {
                        context.enable(pluginMap, this);
                    }
                }));

                this.enabling = false;

                this.check();
            },

            on: function (name, cb) {
                var cbs = this.events[name];
                if (!cbs) {
                    cbs = this.events[name] = [];
                }
                cbs.push(cb);
            },

            emit: function (name, evt) {
                each(this.events[name], function (cb) {
                    cb(evt);
                });
                if (name === 'error') {
                    //Now that the error handler was triggered, remove
                    //the listeners, since this broken Module instance
                    //can stay around for a while in the registry.
                    delete this.events[name];
                }
            }
        };

        function callGetModule(args) {
            //Skip modules already defined.
            if (!hasProp(defined, args[0])) {
                getModule(makeModuleMap(args[0], null, true)).init(args[1], args[2]);
            }
        }

        function removeListener(node, func, name, ieName) {
            //Favor detachEvent because of IE9
            //issue, see attachEvent/addEventListener comment elsewhere
            //in this file.
            if (node.detachEvent && !isOpera) {
                //Probably IE. If not it will throw an error, which will be
                //useful to know.
                if (ieName) {
                    node.detachEvent(ieName, func);
                }
            } else {
                node.removeEventListener(name, func, false);
            }
        }

        /**
         * Given an event from a script node, get the requirejs info from it,
         * and then removes the event listeners on the node.
         * @param {Event} evt
         * @returns {Object}
         */
        function getScriptData(evt) {
            //Using currentTarget instead of target for Firefox 2.0's sake. Not
            //all old browsers will be supported, but this one was easy enough
            //to support and still makes sense.
            var node = evt.currentTarget || evt.srcElement;

            //Remove the listeners once here.
            removeListener(node, context.onScriptLoad, 'load', 'onreadystatechange');
            removeListener(node, context.onScriptError, 'error');

            return {
                node: node,
                id: node && node.getAttribute('data-requiremodule')
            };
        }

        function intakeDefines() {
            var args;

            //Any defined modules in the global queue, intake them now.
            takeGlobalQueue();

            //Make sure any remaining defQueue items get properly processed.
            while (defQueue.length) {
                args = defQueue.shift();
                if (args[0] === null) {
                    return onError(makeError('mismatch', 'Mismatched anonymous define() module: ' + args[args.length - 1]));
                } else {
                    //args are id, deps, factory. Should be normalized by the
                    //define() function.
                    callGetModule(args);
                }
            }
        }

        context = {
            config: config,
            contextName: contextName,
            registry: registry,
            defined: defined,
            urlFetched: urlFetched,
            defQueue: defQueue,
            Module: Module,
            makeModuleMap: makeModuleMap,
            nextTick: req.nextTick,
            onError: onError,

            /**
             * Set a configuration for the context.
             * @param {Object} cfg config object to integrate.
             */
            configure: function (cfg) {
                //Make sure the baseUrl ends in a slash.
                if (cfg.baseUrl) {
                    if (cfg.baseUrl.charAt(cfg.baseUrl.length - 1) !== '/') {
                        cfg.baseUrl += '/';
                    }
                }

                //Save off the paths and packages since they require special processing,
                //they are additive.
                var pkgs = config.pkgs,
                    shim = config.shim,
                    objs = {
                        paths: true,
                        config: true,
                        map: true
                    };

                eachProp(cfg, function (value, prop) {
                    if (objs[prop]) {
                        if (prop === 'map') {
                            if (!config.map) {
                                config.map = {};
                            }
                            mixin(config[prop], value, true, true);
                        } else {
                            mixin(config[prop], value, true);
                        }
                    } else {
                        config[prop] = value;
                    }
                });

                //Merge shim
                if (cfg.shim) {
                    eachProp(cfg.shim, function (value, id) {
                        //Normalize the structure
                        if (isArray(value)) {
                            value = {
                                deps: value
                            };
                        }
                        if ((value.exports || value.init) && !value.exportsFn) {
                            value.exportsFn = context.makeShimExports(value);
                        }
                        shim[id] = value;
                    });
                    config.shim = shim;
                }

                //Adjust packages if necessary.
                if (cfg.packages) {
                    each(cfg.packages, function (pkgObj) {
                        var location;

                        pkgObj = typeof pkgObj === 'string' ? { name: pkgObj } : pkgObj;
                        location = pkgObj.location;

                        //Create a brand new object on pkgs, since currentPackages can
                        //be passed in again, and config.pkgs is the internal transformed
                        //state for all package configs.
                        pkgs[pkgObj.name] = {
                            name: pkgObj.name,
                            location: location || pkgObj.name,
                            //Remove leading dot in main, so main paths are normalized,
                            //and remove any trailing .js, since different package
                            //envs have different conventions: some use a module name,
                            //some use a file name.
                            main: (pkgObj.main || 'main')
                                .replace(currDirRegExp, '')
                                .replace(jsSuffixRegExp, '')
                        };
                    });

                    //Done with modifications, assing packages back to context config
                    config.pkgs = pkgs;
                }

                //If there are any "waiting to execute" modules in the registry,
                //update the maps for them, since their info, like URLs to load,
                //may have changed.
                eachProp(registry, function (mod, id) {
                    //If module already has init called, since it is too
                    //late to modify them, and ignore unnormalized ones
                    //since they are transient.
                    if (!mod.inited && !mod.map.unnormalized) {
                        mod.map = makeModuleMap(id);
                    }
                });

                //If a deps array or a config callback is specified, then call
                //require with those args. This is useful when require is defined as a
                //config object before require.js is loaded.
                if (cfg.deps || cfg.callback) {
                    context.require(cfg.deps || [], cfg.callback);
                }
            },

            makeShimExports: function (value) {
                function fn() {
                    var ret;
                    if (value.init) {
                        ret = value.init.apply(global, arguments);
                    }
                    return ret || (value.exports && getGlobal(value.exports));
                }
                return fn;
            },

            makeRequire: function (relMap, options) {
                options = options || {};

                function localRequire(deps, callback, errback) {
                    var id, map, requireMod;

                    if (options.enableBuildCallback && callback && isFunction(callback)) {
                        callback.__requireJsBuild = true;
                    }

                    if (typeof deps === 'string') {
                        if (isFunction(callback)) {
                            //Invalid call
                            return onError(makeError('requireargs', 'Invalid require call'), errback);
                        }

                        //If require|exports|module are requested, get the
                        //value for them from the special handlers. Caveat:
                        //this only works while module is being defined.
                        if (relMap && hasProp(handlers, deps)) {
                            return handlers[deps](registry[relMap.id]);
                        }

                        //Synchronous access to one module. If require.get is
                        //available (as in the Node adapter), prefer that.
                        if (req.get) {
                            return req.get(context, deps, relMap, localRequire);
                        }

                        //Normalize module name, if it contains . or ..
                        map = makeModuleMap(deps, relMap, false, true);
                        id = map.id;

                        if (!hasProp(defined, id)) {
                            return onError(makeError('notloaded', 'Module name "' +
                                id +
                                '" has not been loaded yet for context: ' +
                                contextName +
                                (relMap ? '' : '. Use require([])')));
                        }
                        return defined[id];
                    }

                    //Grab defines waiting in the global queue.
                    intakeDefines();

                    //Mark all the dependencies as needing to be loaded.
                    context.nextTick(function () {
                        //Some defines could have been added since the
                        //require call, collect them.
                        intakeDefines();

                        requireMod = getModule(makeModuleMap(null, relMap));

                        //Store if map config should be applied to this require
                        //call for dependencies.
                        requireMod.skipMap = options.skipMap;

                        requireMod.init(deps, callback, errback, {
                            enabled: true
                        });

                        checkLoaded();
                    });

                    return localRequire;
                }

                mixin(localRequire, {
                    isBrowser: isBrowser,

                    /**
                     * Converts a module name + .extension into an URL path.
                     * *Requires* the use of a module name. It does not support using
                     * plain URLs like nameToUrl.
                     */
                    toUrl: function (moduleNamePlusExt) {
                        var ext,
                            index = moduleNamePlusExt.lastIndexOf('.'),
                            segment = moduleNamePlusExt.split('/')[0],
                            isRelative = segment === '.' || segment === '..';

                        //Have a file extension alias, and it is not the
                        //dots from a relative path.
                        if (index !== -1 && (!isRelative || index > 1)) {
                            ext = moduleNamePlusExt.substring(index, moduleNamePlusExt.length);
                            moduleNamePlusExt = moduleNamePlusExt.substring(0, index);
                        }

                        return context.nameToUrl(normalize(moduleNamePlusExt,
                            relMap && relMap.id, true), ext,  true);
                    },

                    defined: function (id) {
                        return hasProp(defined, makeModuleMap(id, relMap, false, true).id);
                    },

                    specified: function (id) {
                        id = makeModuleMap(id, relMap, false, true).id;
                        return hasProp(defined, id) || hasProp(registry, id);
                    }
                });

                //Only allow undef on top level require calls
                if (!relMap) {
                    localRequire.undef = function (id) {
                        //Bind any waiting define() calls to this context,
                        //fix for #408
                        takeGlobalQueue();

                        var map = makeModuleMap(id, relMap, true),
                            mod = getOwn(registry, id);

                        delete defined[id];
                        delete urlFetched[map.url];
                        delete undefEvents[id];

                        if (mod) {
                            //Hold on to listeners in case the
                            //module will be attempted to be reloaded
                            //using a different config.
                            if (mod.events.defined) {
                                undefEvents[id] = mod.events;
                            }

                            cleanRegistry(id);
                        }
                    };
                }

                return localRequire;
            },

            /**
             * Called to enable a module if it is still in the registry
             * awaiting enablement. A second arg, parent, the parent module,
             * is passed in for context, when this method is overriden by
             * the optimizer. Not shown here to keep code compact.
             */
            enable: function (depMap) {
                var mod = getOwn(registry, depMap.id);
                if (mod) {
                    getModule(depMap).enable();
                }
            },

            /**
             * Internal method used by environment adapters to complete a load event.
             * A load event could be a script load or just a load pass from a synchronous
             * load call.
             * @param {String} moduleName the name of the module to potentially complete.
             */
            completeLoad: function (moduleName) {
                var found, args, mod,
                    shim = getOwn(config.shim, moduleName) || {},
                    shExports = shim.exports;

                takeGlobalQueue();

                while (defQueue.length) {
                    args = defQueue.shift();
                    if (args[0] === null) {
                        args[0] = moduleName;
                        //If already found an anonymous module and bound it
                        //to this name, then this is some other anon module
                        //waiting for its completeLoad to fire.
                        if (found) {
                            break;
                        }
                        found = true;
                    } else if (args[0] === moduleName) {
                        //Found matching define call for this script!
                        found = true;
                    }

                    callGetModule(args);
                }

                //Do this after the cycle of callGetModule in case the result
                //of those calls/init calls changes the registry.
                mod = getOwn(registry, moduleName);

                if (!found && !hasProp(defined, moduleName) && mod && !mod.inited) {
                    if (config.enforceDefine && (!shExports || !getGlobal(shExports))) {
                        if (hasPathFallback(moduleName)) {
                            return;
                        } else {
                            return onError(makeError('nodefine',
                                'No define call for ' + moduleName,
                                null,
                                [moduleName]));
                        }
                    } else {
                        //A script that does not call define(), so just simulate
                        //the call for it.
                        callGetModule([moduleName, (shim.deps || []), shim.exportsFn]);
                    }
                }

                checkLoaded();
            },

            /**
             * Converts a module name to a file path. Supports cases where
             * moduleName may actually be just an URL.
             * Note that it **does not** call normalize on the moduleName,
             * it is assumed to have already been normalized. This is an
             * internal API, not a public one. Use toUrl for the public API.
             */
            nameToUrl: function (moduleName, ext, skipExt) {
                var paths, pkgs, pkg, pkgPath, syms, i, parentModule, url,
                    parentPath;

                //If a colon is in the URL, it indicates a protocol is used and it is just
                //an URL to a file, or if it starts with a slash, contains a query arg (i.e. ?)
                //or ends with .js, then assume the user meant to use an url and not a module id.
                //The slash is important for protocol-less URLs as well as full paths.
                if (req.jsExtRegExp.test(moduleName)) {
                    //Just a plain path, not module name lookup, so just return it.
                    //Add extension if it is included. This is a bit wonky, only non-.js things pass
                    //an extension, this method probably needs to be reworked.
                    url = moduleName + (ext || '');
                } else {
                    //A module that needs to be converted to a path.
                    paths = config.paths;
                    pkgs = config.pkgs;

                    syms = moduleName.split('/');
                    //For each module name segment, see if there is a path
                    //registered for it. Start with most specific name
                    //and work up from it.
                    for (i = syms.length; i > 0; i -= 1) {
                        parentModule = syms.slice(0, i).join('/');
                        pkg = getOwn(pkgs, parentModule);
                        parentPath = getOwn(paths, parentModule);
                        if (parentPath) {
                            //If an array, it means there are a few choices,
                            //Choose the one that is desired
                            if (isArray(parentPath)) {
                                parentPath = parentPath[0];
                            }
                            syms.splice(0, i, parentPath);
                            break;
                        } else if (pkg) {
                            //If module name is just the package name, then looking
                            //for the main module.
                            if (moduleName === pkg.name) {
                                pkgPath = pkg.location + '/' + pkg.main;
                            } else {
                                pkgPath = pkg.location;
                            }
                            syms.splice(0, i, pkgPath);
                            break;
                        }
                    }

                    //Join the path parts together, then figure out if baseUrl is needed.
                    url = syms.join('/');
                    url += (ext || (/\?/.test(url) || skipExt ? '' : '.js'));
                    url = (url.charAt(0) === '/' || url.match(/^[\w\+\.\-]+:/) ? '' : config.baseUrl) + url;
                }

                return config.urlArgs ? url +
                    ((url.indexOf('?') === -1 ? '?' : '&') +
                        config.urlArgs) : url;
            },

            //Delegates to req.load. Broken out as a separate function to
            //allow overriding in the optimizer.
            load: function (id, url) {
                req.load(context, id, url);
            },

            /**
             * Executes a module callack function. Broken out as a separate function
             * solely to allow the build system to sequence the files in the built
             * layer in the right sequence.
             *
             * @private
             */
            execCb: function (name, callback, args, exports) {
                return callback.apply(exports, args);
            },

            /**
             * callback for script loads, used to check status of loading.
             *
             * @param {Event} evt the event from the browser for the script
             * that was loaded.
             */
            onScriptLoad: function (evt) {
                //Using currentTarget instead of target for Firefox 2.0's sake. Not
                //all old browsers will be supported, but this one was easy enough
                //to support and still makes sense.
                if (evt.type === 'load' ||
                    (readyRegExp.test((evt.currentTarget || evt.srcElement).readyState))) {
                    //Reset interactive script so a script node is not held onto for
                    //to long.
                    interactiveScript = null;

                    //Pull out the name of the module and the context.
                    var data = getScriptData(evt);
                    context.completeLoad(data.id);
                }
            },

            /**
             * Callback for script errors.
             */
            onScriptError: function (evt) {
                var data = getScriptData(evt);
                if (!hasPathFallback(data.id)) {
                    return onError(makeError('scripterror', 'Script error', evt, [data.id]));
                }
            }
        };

        context.require = context.makeRequire();
        return context;
    }

    /**
     * Main entry point.
     *
     * If the only argument to require is a string, then the module that
     * is represented by that string is fetched for the appropriate context.
     *
     * If the first argument is an array, then it will be treated as an array
     * of dependency string names to fetch. An optional function callback can
     * be specified to execute when all of those dependencies are available.
     *
     * Make a local req variable to help Caja compliance (it assumes things
     * on a require that are not standardized), and to give a short
     * name for minification/local scope use.
     */
    req = requirejs = function (deps, callback, errback, optional) {

        //Find the right context, use default
        var context, config,
            contextName = defContextName;

        // Determine if have config object in the call.
        if (!isArray(deps) && typeof deps !== 'string') {
            // deps is a config object
            config = deps;
            if (isArray(callback)) {
                // Adjust args if there are dependencies
                deps = callback;
                callback = errback;
                errback = optional;
            } else {
                deps = [];
            }
        }

        if (config && config.context) {
            contextName = config.context;
        }

        context = getOwn(contexts, contextName);
        if (!context) {
            context = contexts[contextName] = req.s.newContext(contextName);
        }

        if (config) {
            context.configure(config);
        }

        return context.require(deps, callback, errback);
    };

    /**
     * Support require.config() to make it easier to cooperate with other
     * AMD loaders on globally agreed names.
     */
    req.config = function (config) {
        return req(config);
    };

    /**
     * Execute something after the current tick
     * of the event loop. Override for other envs
     * that have a better solution than setTimeout.
     * @param  {Function} fn function to execute later.
     */
    req.nextTick = typeof setTimeout !== 'undefined' ? function (fn) {
        setTimeout(fn, 4);
    } : function (fn) { fn(); };

    /**
     * Export require as a global, but only if it does not already exist.
     */
    if (!require) {
        require = req;
    }

    req.version = version;

    //Used to filter out dependencies that are already paths.
    req.jsExtRegExp = /^\/|:|\?|\.js$/;
    req.isBrowser = isBrowser;
    s = req.s = {
        contexts: contexts,
        newContext: newContext
    };

    //Create default context.
    req({});

    //Exports some context-sensitive methods on global require.
    each([
        'toUrl',
        'undef',
        'defined',
        'specified'
    ], function (prop) {
        //Reference from contexts instead of early binding to default context,
        //so that during builds, the latest instance of the default context
        //with its config gets used.
        req[prop] = function () {
            var ctx = contexts[defContextName];
            return ctx.require[prop].apply(ctx, arguments);
        };
    });

    if (isBrowser) {
        head = s.head = document.getElementsByTagName('head')[0];
        //If BASE tag is in play, using appendChild is a problem for IE6.
        //When that browser dies, this can be removed. Details in this jQuery bug:
        //http://dev.jquery.com/ticket/2709
        baseElement = document.getElementsByTagName('base')[0];
        if (baseElement) {
            head = s.head = baseElement.parentNode;
        }
    }

    /**
     * Any errors that require explicitly generates will be passed to this
     * function. Intercept/override it if you want custom error handling.
     * @param {Error} err the error object.
     */
    req.onError = function (err) {
        throw err;
    };

    /**
     * Does the request to load a module for the browser case.
     * Make this a separate function to allow other environments
     * to override it.
     *
     * @param {Object} context the require context to find state.
     * @param {String} moduleName the name of the module.
     * @param {Object} url the URL to the module.
     */
    req.load = function (context, moduleName, url) {
        var config = (context && context.config) || {},
            node;
        if (isBrowser) {
            //In the browser so use a script tag
            node = config.xhtml ?
                document.createElementNS('http://www.w3.org/1999/xhtml', 'html:script') :
                document.createElement('script');
            node.type = config.scriptType || 'text/javascript';
            node.charset = 'utf-8';
            node.async = true;

            node.setAttribute('data-requirecontext', context.contextName);
            node.setAttribute('data-requiremodule', moduleName);

            //Set up load listener. Test attachEvent first because IE9 has
            //a subtle issue in its addEventListener and script onload firings
            //that do not match the behavior of all other browsers with
            //addEventListener support, which fire the onload event for a
            //script right after the script execution. See:
            //https://connect.microsoft.com/IE/feedback/details/648057/script-onload-event-is-not-fired-immediately-after-script-execution
            //UNFORTUNATELY Opera implements attachEvent but does not follow the script
            //script execution mode.
            if (node.attachEvent &&
                //Check if node.attachEvent is artificially added by custom script or
                //natively supported by browser
                //read https://github.com/jrburke/requirejs/issues/187
                //if we can NOT find [native code] then it must NOT natively supported.
                //in IE8, node.attachEvent does not have toString()
                //Note the test for "[native code" with no closing brace, see:
                //https://github.com/jrburke/requirejs/issues/273
                !(node.attachEvent.toString && node.attachEvent.toString().indexOf('[native code') < 0) &&
                !isOpera) {
                //Probably IE. IE (at least 6-8) do not fire
                //script onload right after executing the script, so
                //we cannot tie the anonymous define call to a name.
                //However, IE reports the script as being in 'interactive'
                //readyState at the time of the define call.
                useInteractive = true;

                node.attachEvent('onreadystatechange', context.onScriptLoad);
                //It would be great to add an error handler here to catch
                //404s in IE9+. However, onreadystatechange will fire before
                //the error handler, so that does not help. If addEventListener
                //is used, then IE will fire error before load, but we cannot
                //use that pathway given the connect.microsoft.com issue
                //mentioned above about not doing the 'script execute,
                //then fire the script load event listener before execute
                //next script' that other browsers do.
                //Best hope: IE10 fixes the issues,
                //and then destroys all installs of IE 6-9.
                //node.attachEvent('onerror', context.onScriptError);
            } else {
                node.addEventListener('load', context.onScriptLoad, false);
                node.addEventListener('error', context.onScriptError, false);
            }
            node.src = url;

            //For some cache cases in IE 6-8, the script executes before the end
            //of the appendChild execution, so to tie an anonymous define
            //call to the module name (which is stored on the node), hold on
            //to a reference to this node, but clear after the DOM insertion.
            currentlyAddingScript = node;
            if (baseElement) {
                head.insertBefore(node, baseElement);
            } else {
                head.appendChild(node);
            }
            currentlyAddingScript = null;

            return node;
        } else if (isWebWorker) {
            try {
                //In a web worker, use importScripts. This is not a very
                //efficient use of importScripts, importScripts will block until
                //its script is downloaded and evaluated. However, if web workers
                //are in play, the expectation that a build has been done so that
                //only one script needs to be loaded anyway. This may need to be
                //reevaluated if other use cases become common.
                importScripts(url);

                //Account for anonymous modules
                context.completeLoad(moduleName);
            } catch (e) {
                context.onError(makeError('importscripts',
                    'importScripts failed for ' +
                        moduleName + ' at ' + url,
                    e,
                    [moduleName]));
            }
        }
    };

    function getInteractiveScript() {
        if (interactiveScript && interactiveScript.readyState === 'interactive') {
            return interactiveScript;
        }

        eachReverse(scripts(), function (script) {
            if (script.readyState === 'interactive') {
                return (interactiveScript = script);
            }
        });
        return interactiveScript;
    }

    //Look for a data-main script attribute, which could also adjust the baseUrl.
    if (isBrowser) {
        //Figure out baseUrl. Get it from the script tag with require.js in it.
        eachReverse(scripts(), function (script) {
            //Set the 'head' where we can append children by
            //using the script's parent.
            if (!head) {
                head = script.parentNode;
            }

            //Look for a data-main attribute to set main script for the page
            //to load. If it is there, the path to data main becomes the
            //baseUrl, if it is not already set.
            dataMain = script.getAttribute('data-main');
            if (dataMain) {
                //Set final baseUrl if there is not already an explicit one.
                if (!cfg.baseUrl) {
                    //Pull off the directory of data-main for use as the
                    //baseUrl.
                    src = dataMain.split('/');
                    mainScript = src.pop();
                    subPath = src.length ? src.join('/')  + '/' : './';

                    cfg.baseUrl = subPath;
                    dataMain = mainScript;
                }

                //Strip off any trailing .js since dataMain is now
                //like a module name.
                dataMain = dataMain.replace(jsSuffixRegExp, '');

                //Put the data-main script in the files to load.
                cfg.deps = cfg.deps ? cfg.deps.concat(dataMain) : [dataMain];

                return true;
            }
        });
    }

    /**
     * The function that handles definitions of modules. Differs from
     * require() in that a string for the module should be the first argument,
     * and the function to execute after dependencies are loaded should
     * return a value to define the module corresponding to the first argument's
     * name.
     */
    define = function (name, deps, callback) {
        var node, context;

        //Allow for anonymous modules
        if (typeof name !== 'string') {
            //Adjust args appropriately
            callback = deps;
            deps = name;
            name = null;
        }

        //This module may not have dependencies
        if (!isArray(deps)) {
            callback = deps;
            deps = [];
        }

        //If no name, and callback is a function, then figure out if it a
        //CommonJS thing with dependencies.
        if (!deps.length && isFunction(callback)) {
            //Remove comments from the callback string,
            //look for require calls, and pull them into the dependencies,
            //but only if there are function args.
            if (callback.length) {
                callback
                    .toString()
                    .replace(commentRegExp, '')
                    .replace(cjsRequireRegExp, function (match, dep) {
                        deps.push(dep);
                    });

                //May be a CommonJS thing even without require calls, but still
                //could use exports, and module. Avoid doing exports and module
                //work though if it just needs require.
                //REQUIRES the function to expect the CommonJS variables in the
                //order listed below.
                deps = (callback.length === 1 ? ['require'] : ['require', 'exports', 'module']).concat(deps);
            }
        }

        //If in IE 6-8 and hit an anonymous define() call, do the interactive
        //work.
        if (useInteractive) {
            node = currentlyAddingScript || getInteractiveScript();
            if (node) {
                if (!name) {
                    name = node.getAttribute('data-requiremodule');
                }
                context = contexts[node.getAttribute('data-requirecontext')];
            }
        }

        //Always save off evaluating the def call until the script onload handler.
        //This allows multiple modules to be in a file without prematurely
        //tracing dependencies, and allows for anonymous module support,
        //where the module name is not known until the script onload event
        //occurs. If no context, use the global queue, and get it processed
        //in the onscript load callback.
        (context ? context.defQueue : globalDefQueue).push([name, deps, callback]);
    };

    define.amd = {
        jQuery: true
    };


    /**
     * Executes the text. Normally just uses eval, but can be modified
     * to use a better, environment-specific call. Only used for transpiling
     * loader plugins, not for plain JS modules.
     * @param {String} text the text to execute/evaluate.
     */
    req.exec = function (text) {
        /*jslint evil: true */
        return eval(text);
    };

    //Set up with config info.
    req(cfg);
}(this));
define("lib/jrburke/require", function(){});

// conditioner v0.8.1 - A JavaScript framework for conditionally loading UI classes
// Copyright (c) 2013 Rik Schennink - https://github.com/rikschennink/conditioner
// License: MIT (http://www.opensource.org/licenses/mit-license.php)

define('Conditioner',['require'],function(require){

/**
 * @module Conditioner
 */



// based on https://github.com/nrf110/deepmerge/blob/master/index.js
function mergeObjects(target, src) {

    var array = Array.isArray(src);
    var dst = array && [] || {};

    src = src || {};

    if (array) {

        target = target || [];
        dst = dst.concat(target);

        src.forEach(function(e, i) {

            if (typeof e === 'object') {
                dst[i] = mergeObjects(target[i], e);
            }
            else {
                if (target.indexOf(e) === -1) {
                    dst.push(e);
                }
            }
        });
    }
    else {

        if (target && typeof target === 'object') {

            Object.keys(target).forEach(function (key) {
                dst[key] = target[key];
            });

        }

        Object.keys(src).forEach(function (key) {

            if (typeof src[key] !== 'object' || !src[key]) {
                dst[key] = src[key];
            }
            else {
                if (!target[key]) {
                    dst[key] = src[key];
                }
                else {
                    dst[key] = mergeObjects(target[key], src[key]);
                }
            }

        });
    }

    return dst;
}

/**
 * @method matchesSelector
 */
var matchesSelector = (function() {

    var _method = null;
    var el = document.body;
    if (el.matches) {
        _method = 'matches';
    }
    else if (el.webkitMatchesSelector) {
        _method = 'webkitMatchesSelector';
    }
    else if (el.mozMatchesSelector) {
        _method = 'mozMatchesSelector';
    }
    else if (el.msMatchesSelector) {
        _method = 'msMatchesSelector';
    }
    else if (el.oMatchesSelector) {
        _method = 'oMatchesSelector';
    }

    return function(element,selector) {

        if (!element) {
            return false;
        }

        return element[_method](selector);

    };

}());


/**
 * @class Observer
 */
var Observer = (function(){

    return {

        /**
         * Subscribe to an event
         * @method subscribe
         * @param {object} obj - Object to subscribe to
         * @param {string} type - Event type to listen for
         * @param {Function} fn - Function to call when event fires
         */
        subscribe:function(obj,type,fn) {

            if (!obj._subscriptions) {
                obj._subscriptions = [];
            }

            // check if already added
            var test,i=0,l = obj._subscriptions;
            for (; i<l; i++) {
                test = obj._subscriptions[i];
                if (test.type == type && test.fn == fn) {
                    return;
                }
            }

            // add event
            obj._subscriptions.push({'type':type,'fn':fn});
        },

        /**
         * Unsubscribe from further notifications
         * @method unsubscribe
         * @param {object} obj - Object to unsubscribe from
         * @param {string} type - Event type to match
         * @param {Function} fn - Function to match
         */
        unsubscribe:function(obj,type,fn) {

            if (!obj._subscriptions) {
                return;
            }

            // find and remove
            var test,i;
            for (i = obj._subscriptions.length-1; i >= 0; i--) {
                test = obj._subscriptions[i];
                if (test.type == type && test.fn == fn) {
                    obj._subscriptions.splice(i,1);
                    break;
                }
            }
        },

        /**
         * Publish an event
         * @method publish
         * @param {object} obj - Object to fire the event on
         * @param {string} type - Event type to fire
         * @param {object} data - Any type of data
         */
        publish:function(obj,type,data) {

            if (!obj._subscriptions) {
                obj._subscriptions = [];
            }
            
            // find and execute callback
            var test,i=0,l = obj._subscriptions.length;
            for (; i<l; i++) {
                test = obj._subscriptions[i];
                if (test.type == type) {
                    test.fn(data);
                }
            }

            // see if should be propagated
            if (obj._eventPropagationTarget) {
                this.publish(obj._eventPropagationTarget,type,data);
            }

        },

        /**
         * Setup propagation target for events so they can bubble up the object tree
         * @method setupPropagationTarget
         * @param {object} obj - Object to set as origin
         * @param {object} target - Object to set as target
         */
        setupPropagationTarget:function(obj,target) {
            if (!obj) {
                return;
            }
            obj._eventPropagationTarget = target;
        }

    };

}());


/**
 * @class Module
 */
var Module = (function(mergeObjects) {

    /**
     * @constructor
     * @param {Element} element - DOM Element to apply this behavior to
     * @param {object} [options] - Custom options to pass to this behavior
     */
    var Module = function(element,options) {

        // if no element, throw error
        if (!element) {
            throw new Error('BehaviorBase(element,options): "element" is a required parameter.');
        }

        // element reference
        this._element = element;
        this._element.setAttribute('data-initialized','true');

        // declare options as empty
        this._options = this._options || {};
        this._options = options ? mergeObjects(this._options,options) : this._options;

    };


    /**
     * Unloads behaviour by removing data initialized property
     * Override to clean up your control, remove event listeners, restore original state, etc.
     * @method _unload
     */
    Module.prototype._unload = function() {
        this._element.removeAttribute('data-initialized');
    };

    return Module;

}(mergeObjects));


/**
 * @class Test
 */
var Test = (function(Observer){

    /**
     * @constructor
     * @param {object} expected - expected conditions to be met
     * @param {Element} [element] - optional element to measure these conditions on
     */
    var Test = function(expected,element) {

        // store element
        this._element = element;

        // set default state
        this._state = true;

        // rules to test
        this._rules = [];

        // transform expected object into separate rules
        if (expected instanceof Array || typeof expected != 'object') {
            this._addRule(expected);
        }
        else if (typeof expected == 'object') {
            for (var key in expected) {
                if (!expected.hasOwnProperty(key)){continue;}
                this._addRule(expected[key],key);
            }
        }

    };

    Test.inherit = function() {
        var T = function(expected,element) {
            Test.call(this,expected,element);
        };
        T.prototype = Object.create(Test.prototype);
        return T;
    };

    var p = Test.prototype;

    p._addRule = function(value,key) {

        if (!value) {
            throw new Error('TestBase._addRule(value,key): "value" is a required parameter.');
        }

        this._rules.push({
            'key':typeof key == 'undefined' ? 'default' : key,
            'value':value
        });

    };

    p._test = function(rule) {

        // override in subclass

    };

    p.arrange = function() {

        // override in subclass

    };

    p.assert = function() {

        var i=0,l=this._rules.length,result = true;
        for (;i<l;i++) {
            if (!this._test(this._rules[i])) {
                result = false;
                break;
            }
        }

        if (this._state!= result) {
            this._state = result;
            Observer.publish(this,'change',result);
        }

    };

    p.succeeds = function() {
        return this._state;
    };

    return Test;

}(Observer));


/**
 * @class ModuleRegister
 */
var ModuleRegister = {

    _modules:{},

    /**
     * Register a module
     * @method registerModule
     * @param {string} path - path to module
     * @param {object} config - configuration to setupe for module
     * @param {string} alias - alias name for module
     */
    registerModule:function(path,config,alias) {

        var key=alias||path,map,conf;

        // setup module entry
        this._modules[key] = {};

        // check if has config defined
        if (config) {

            // set config entry
            this._modules[key].config = config;

            // update requirejs
            conf = {};
            conf[path] = config;
            requirejs.config({
                config:conf
            });

        }

        // check if has alias defined
        if (alias) {

            // set alias entry
            this._modules[key].alias = alias;

            // update requirejs
            map = {};
            map[alias] = path;
            requirejs.config({
                map:{
                    '*':map
                }
            });
        }

    },

    /**
     * Get a registered module by path
     * @method getModuleByPath
     * @param {string} path - path to module
     * @return {object} - module specification object
     */
    getModuleByPath:function(path) {

        // if no id supplied throw error
        if (!path) {
            throw new Error('ModuleRegister.getModuleById(path): "path" is a required parameter.');
        }

        return this._modules[path];

    }

};

/**
 * @class ConditionManager
 */
var ConditionManager = (function(require){

    /**
     * @constructor
     * @param {object} expected - expected conditions to be met
     * @param {Element} [element] - optional element to measure these conditions on
     */
    var ConditionManager = function(expected,element) {

        // if the conditions are suitable, by default they are
        this._suitable = true;

        // if no conditions, conditions will always be suitable
        if (!expected) {
            return;
        }

        // conditions supplied, conditions are now unsuitable by default
        this._suitable = false;

        // if expected is in string format try to parse as JSON
        if (typeof expected == 'string') {
            try {
                expected = JSON.parse(expected);
            }
            catch(e) {
                console.warn('ConditionManager(expected,element): expected conditions should be in JSON format.');
                return;
            }
        }

        // event bind
        this._onResultsChangedBind = this._onTestResultsChanged.bind(this);

        // set properties
        this._tests = [];

        // set conditions array
        this._count = 0;

        // parse expected
        var key;
        for (key in expected) {

            // skip if not own property
            if (!expected.hasOwnProperty(key)) {continue;}

            // up count
            this._count++;

            // load test for expectation with supplied key
            this._loadTest(key,expected,element);

        }
    };



    // prototype shortcut
    ConditionManager.prototype = {


        /**
         * Called to load a test
         * @method _loadTest
         * @param {string} path - path to the test module
         * @param {object} expected - Expected value for this test
         * @param {node} [element] - Element related to this test
         */
        _loadTest:function(path,expected,element) {

            var self = this;

            require(['tests/' + path],function(Test){

                //condition = new Condition(
                var test = new Test(expected[path],element);

                // add to tests array
                self._tests.push(test);

                // another test loaded
                self._onLoadTest();

            });

        },


        /**
         * Called when a test was loaded
         * @method _onLoadTest
         */
        _onLoadTest:function() {

            // lower count if test loaded
            this._count--;

            // if count reaches zero all tests have been loaded
            if (this._count==0) {
                this._onReady();
            }

        },

        /**
         * Called when all tests are ready
         * @method _onReady
         */
        _onReady:function() {

            var l = this._tests.length,test,i;
            for (i=0;i<l;i++) {
                test = this._tests[i];

                // arrange test
                test.arrange();

                // execute test
                test.assert();

                // listen to changes
                Observer.subscribe(test,'change',this._onResultsChangedBind);
            }

            // test current state
            this.test();
        },


        /**
         * Called when a condition has changed
         * @method _onConditionsChanged
         */
        _onTestResultsChanged:function() {
            this.test();
        },


        /**
         * Tests if conditions are suitable
         * @method test
         */
        test:function() {

            // check all conditions on suitability
            var suitable = true,l = this._tests.length,test,i;
            for (i=0;i<l;i++) {
                test = this._tests[i];
                if (!test.succeeds()) {
                    suitable = false;
                    break;
                }
            }

            // fire changed event if environment suitability changed
            if (suitable != this._suitable) {
                this._suitable = suitable;
                Observer.publish(this,'change');
            }

        },


        /**
         * Returns true if the current conditions are suitable
         * @method getSuitability
         */
        getSuitability:function() {
            return this._suitable;
        }
    };

    return ConditionManager;

}(require));


/**
 * @class ModuleController
 */
var ModuleController = (function(require,ModuleRegister,ConditionManager,matchesSelector,mergeObjects){

    /**
     * @constructor
     * @param {string} path - reference to module
     * @param {object} options - options for this behavior controller
     */
    var ModuleController = function(path,options) {
        
        // if no element, throw error
        if (!path) {
            throw new Error('ModuleController(path,options): "path" is a required parameter.');
        }

        // options for class behavior controller should load
        this._path = path;

        // options for behavior controller
        this._options = options || {};
        this._options.suitable = typeof this._options.suitable === 'undefined' ? true : this._options.suitable;

        // module reference
        this._module = null;

    };


    // prototype shortcut
    var p = ModuleController.prototype;


    /**
     * Initializes the module controller
     * @method init
     */
    p.init = function() {

        // check if conditions specified
        this._conditionManager = new ConditionManager(
            this._options.conditions,
            this._options.target
        );

        // listen to changes in conditions
        Observer.subscribe(this._conditionManager,'change',this._onConditionsChange.bind(this));

        // if already suitable, load module
        if (this._conditionManager.getSuitability() === this._options.suitable) {
            this._loadModule();
        }

    };


    /**
     * Called when the conditions change.
     * @method _onConditionsChange
     */
    p._onConditionsChange = function() {

        var suitable = this._conditionManager.getSuitability();

        if (this._module && suitable !== this._options.suitable) {
            this.unloadModule();
        }

        if (!this._module && suitable === this._options.suitable) {
            this._loadModule();
        }

    };


    /**
     * Load the module set in the referenced in the path property
     * @method _loadModule
     */
    p._loadModule = function() {

        var self = this;

        require([this._path],function(klass){

            // get module specification
            var specification = ModuleRegister.getModuleByPath(self._path),
                moduleOptions = specification ? specification.config : {},
                elementOptions = {},
                options;

            // parse element options
            if (typeof self._options.options == 'string') {
                try {
                    elementOptions = JSON.parse(self._options.options);
                }
                catch(e) {}
            }
            else {
                elementOptions = self._options.options;
            }

            // merge options if necessary
            options = moduleOptions ? mergeObjects(moduleOptions,elementOptions) : elementOptions;

            // create instance of behavior klass
            self._module = new klass(self._options.target,options);

            // propagate events from behavior to behaviorController
            Observer.setupPropagationTarget(self._module,self);

        });

    };


    /**
     * Public method for unloading the module
     * @method unloadModule
     * @return {boolean}
     */
    p.unloadModule = function() {

        if (!this._module) {
            return false;
        }

        // unload behavior if possible
        if (this._module._unload) {
            this._module._unload();
        }

        // reset property
        this._module = null;

        return true;
    };


    /**
     * Public method to check if the module matches the given query
     * @method matchesQuery
     * @param {object || string} query - string query to match or object to match
     * @return {boolean} if matched
     */
    p.matchesQuery = function(query) {

        if (typeof query == 'string') {

            // check if matches query
            if (matchesSelector(this._options.target,query)) {
                return true;
            }
            
        }

        return (query == this._options.target);
    };



    /**
     * Public method for safely executing methods on the loaded module
     * @method execute
     * @param {string} method - method key
     * @param {Array} [params] - array containing the method parameters
     * @return
     */
    p.execute = function(method,params) {

        // if behavior not loaded
        if (!this._module) {
            return null;
        }

        // get function reference
        var F = this._module[method];
        if (!F) {
            throw new Error('Conditioner(method,params): "method" not found on module.');
        }

        // once loaded call method and pass parameters
        return F.apply(this._module,params);

    };

    return ModuleController;

}(require,ModuleRegister,ConditionManager,matchesSelector,mergeObjects));


/**
 * @class Conditioner
 */
var Conditioner = (function(ModuleRegister,ModuleController,mergeObjects,Test,Module,Observer){


    /**
     * @constructor
     */
    var Conditioner = function() {

        // options for conditioner
        this._options = {
            'attribute':{
                'module':'data-module',
                'conditions':'data-conditions',
                'options':'data-options',
                'priority':'data-priority'
            },
            'modules':{}
        };

        // array of all active controllers
        this._controllers = [];

    };

    // prototype shortcut
    var p = Conditioner.prototype;


    /**
     * @method setOptions, set custom options
     * @param {object} options - options to override
     */
    p.setOptions = function(options) {

        // update options
        this._options = mergeObjects(this._options,options);

        // loop over modules
        var config,path,mod,alias;
        for (path in this._options.modules) {

            if (!this._options.modules.hasOwnProperty(path)){continue;}

            // get module reference
            mod = this._options.modules[path];

            // get alias
            alias = typeof mod === 'string' ? mod : mod.alias;

            // get config
            config = typeof mod === 'string' ? null : mod.options || {};

            // register this module
            ModuleRegister.registerModule(path,config,alias);

        }


    };


    /**
     * Loads modules within the given context.
     *
     * @method loadModules
     * @param {Element} context - Context to find modules in
     * @return {Array} - Array of initialized ModuleControllers
     */
    p.loadModules = function(context) {

        // if no context supplied throw error
        if (!context) {
            throw new Error('Conditioner.loadModules(context): "context" is a required parameter.');
        }

        // register vars and get elements
        var elements = context.querySelectorAll('[' + this._options.attribute.module + ']'),
            i = 0,
            l = elements.length,
            controllers = [],
            priorityList = [],
            controller,
            element,
            specs,
            spec;

        // if no elements do nothing
        if (!elements) {
            return [];
        }

        // process elements
        for (; i<l; i++) {

            // set element reference
            element = elements[i];

            // skip element if already processed
            if (element.getAttribute('data-processed') == 'true') {
                continue;
            }

            // has been processed
            element.setAttribute('data-processed','true');

            // get specs
            specs = this._getModuleSpecificationsByElement(element);

            // apply specs
            while (spec = specs.shift()) {

                // create controller instance
                controller = new ModuleController(
                    spec.path,
                    {
                        'target':element,
                        'conditions':spec.conditions,
                        'options':spec.options
                    }
                );

                // add to priority list
                priorityList.push({
                    'controller':controller,
                    'priority':spec.priority
                });

                // add to controllers
                controllers.push(controller);
            }
        }

        // sort controllers by priority:
        // higher numbers go first,
        // then 0 (or no priority assigned),
        // then negative numbers
        priorityList.sort(function(a,b){
            return b.priority - a.priority;
        });

        // initialize modules depending on assigned priority
        l = controllers.length;
        for (i=0; i<l; i++) {
            priorityList[i].controller.init();
        }

        // merge new controllers with current controllers
        this._controllers = this._controllers.concat(controllers);

        // returns copy of controllers so it is possible to later unload modules manually if necessary
        return controllers;
    };


    /**
     * Reads specifications for module from the element attributes
     *
     * @method _getModuleSpecificationsByElement
     * @param {Element} element - Element to parse
     * @return {Array} behavior specifications
     */
    p._getModuleSpecificationsByElement = function(element) {

        var path = element.getAttribute(this._options.attribute.module),
            advanced = path.charAt(0) === '[',
            result = [],specs;

        // if advanced specifications parse path
        if (advanced) {

            try {
                specs = JSON.parse(path);
            }
            catch(e) {
                // failed parsing spec
            }

            // no specification found or specification parsing failed
            if (!specs) {
                return result;
            }

            // setup vars
            var l=specs.length,i=0,spec;

            // create specs
            for (;i<l;i++) {

                spec = specs[i];
                result.push({
                    'path':spec.path,
                    'conditions':spec.conditions,
                    'options':spec.options,
                    'priority':spec.priority
                });

            }
        }
        else {

            // set single module spec
            result.push({
                'path':path,
                'conditions':element.getAttribute(this._options.attribute.conditions),
                'options':element.getAttribute(this._options.attribute.options),
                'priority':element.getAttribute(this._options.attribute.priority)
            });

        }

        return result;

    };


    /**
     * Returns ModuleControllers matching the selector
     *
     * @method getModule
     * @param {object} query - Query to match the ModuleController to, could be ClassPath, Element or CSS Selector
     * @return {object} controller - First matched ModuleController
     */
    p.getModule = function(query) {
        var controller,i=0,l = this._controllers.length;
        for (;i<l;i++) {
            controller = this._controllers[i];
            if (controller.matchesQuery(query)) {
                return controller;
            }
        }
        return null;
    };


    /**
     * Returns all ModuleControllers matching the selector
     *
     * @method getModuleAll
     * @param {object} query - Query to match the controller to, could be ClassPath, Element or CSS Selector
     * @return {Array} results - Array containing matched behavior controllers
     */
    p.getModuleAll = function(query) {
        if (typeof query == 'undefined') {
            return this._controllers.concat();
        }
        var controller,i=0,l = this._controllers.length,results=[];
        for (;i<l;i++) {
            controller = this._controllers[i];
            if (controller.matchesQuery(query)) {
                results.push(controller);
            }
        }
        return results;
    };


    // Singleton structure
    var _instance;

    return {

        /**
         * Returns an instance of the Conditioner
         * @method getInstance
         * @return instance of Conditioner
         */
        getInstance:function() {
            if (!_instance) {_instance = new Conditioner();}
            return _instance;
        },

        /**
         * Reference to Test base class
         */
        Test:Test,

        /**
         * Reference to Module base class
         */
        Module:Module,

        /**
         * Reference to Observer class
         */
        Observer:Observer,

        /**
         * Reference to updateObject method
         */
        mergeObjects:mergeObjects

    };

}(ModuleRegister,ModuleController,mergeObjects,Test,Module,Observer));


// expose conditioner
return Conditioner;

});


/**
 * Tests if an active network connection is available and monitors this connection
 * @module tests/Connection
 */
define('tests/Connection',['Conditioner'],function(Conditioner){

    

    var Test = Conditioner.Test.inherit(),
    p = Test.prototype;

    p.handleEvent = function(e) {
        this.assert();
    };

    p.arrange = function() {
        if (navigator.connection) {
            navigator.connection.addEventListener('change', this, false);
        }
    };

    p._test = function(rule) {
        return rule.value == 'any' && navigator.onLine;
    };

    return Test;

});

define('security/StorageConsentGuard',['Conditioner','module'],function(Conditioner,module){

    

    // StorageConsentGuard
    var StorageConsentGuard = function() {

        // current level
        this._level = null;

        // default options
        this._options = {
            'initial':'all',
            'levels':['all','none']
        };

        // set options
        this.setOptions(module.config());

        // set default level
        this._setDefaultLevel();
    };

    var p = StorageConsentGuard.prototype;

    p.setOptions = function(options) {

        if (!options) {
            return;
        }

        // sets initial options
        this._options = Conditioner.mergeObjects(this._options,options);

        this._setDefaultLevel();
    };

    p._setDefaultLevel = function() {
        this.setActiveLevel(this._options.initial);
    };

    p.getLevels = function() {
        return this._options.levels;
    };

    p.getActiveLevel = function() {
        return this._level;
    };

    p.setActiveLevel = function(level) {

        if (level == this._level) {
            return;
        }

        this._level = level;

        Conditioner.Observer.publish(this,'change',this._level);
    };


    // reference to singleton
    var _instance;

    return {
        getInstance:function() {
            if (!_instance) { _instance = new StorageConsentGuard(); }
            return _instance;
        }
    };

});

/**
 * Tests if what consent the user has given concerning cookie storage
 * @module security/StorageConsentGuard
 */
define('tests/Cookies',['Conditioner','security/StorageConsentGuard'],function(Conditioner,StorageConsentGuard){

    var Test = Conditioner.Test.inherit(),
        p = Test.prototype;

    p.arrange = function() {

        var guard = StorageConsentGuard.getInstance();

        var self = this;
        Conditioner.Observer.subscribe(guard,'change',function() {
            self.assert();
        });
    };

    p._test = function(rule) {

        var guard = StorageConsentGuard.getInstance(),
            level = guard.getActiveLevel();

        return rule.value.indexOf(level) > -1;

    };

    return Test;

});

/**
 * Tests if an elements dimensions match certain expectations
 * @module tests/Element
 */
define('tests/Element',['Conditioner'],function(Conditioner){

    

    var Test = Conditioner.Test.inherit(),
    p = Test.prototype;

    p.handleEvent = function(e) {
        this.assert();
    };

    p.arrange = function() {
        window.addEventListener('resize',this,false);
        window.addEventListener('scroll',this,false);
    };

    p._test = function(rule) {

        switch(rule.key) {
            case 'min-width':{
                return this._element.offsetWidth >= rule.value;
            }
            case 'max-width':{
                return this._element.offsetWidth <= rule.value;
            }
            case 'visible':{
                var viewHeight = window.innerHeight;
                var bounds = this._element.getBoundingClientRect();
                return ((bounds.top > 0 && bounds.top < viewHeight) || (bounds.bottom > 0 && bounds.bottom < viewHeight)) === rule.value;
            }
        }

        return true;
    };

    return Test;

});


/**
 * Tests if a media query is matched or not and listens to changes
 * @module tests/Media
 */
define('tests/Media',['Conditioner'],function(Conditioner){

    

    var Test = Conditioner.Test.inherit(),
    p = Test.prototype;

    p._mql = null;

    p.arrange = function() {

        var self = this;
        this._mql = window.matchMedia(this._rules[0].value);
        this._mql.addListener(function(){
            self.assert();
        });

    };

    p._test = function() {
        return this._mql.matches;
    };

    return Test;

});


/**
 * Tests if the user is using a pointer device
 * @module tests/Pointer
 */
define('tests/Pointer',['Conditioner'],function(Conditioner){

    

    var Test = Conditioner.Test.inherit(),
    p = Test.prototype,
    MOUSE_MOVES_REQUIRED = 2;

    p._totalMouseMoves = 0;

    p.handleEvent = function(e) {
        if (e.type == 'mousemove') {
            this._totalMouseMoves++;
            if (this._totalMouseMoves >= MOUSE_MOVES_REQUIRED) {
                document.removeEventListener('mousemove',this,false);
                document.removeEventListener('mousedown',this,false);
            }
        }
        else {
            this._totalMouseMoves = 0;
        }
        this.assert();
    };

    p.arrange = function() {

        // start listening to mousemoves to deduct the availability of a pointer device
        document.addEventListener('mousemove',this,false);
        document.addEventListener('mousedown',this,false);

        // start timer, stop testing after 10 seconds
        var self = this;
        setTimeout(function(){
            document.removeEventListener('mousemove',self,false);
            document.removeEventListener('mousedown',self,false);
        },10000);
    };

    p._test = function(rule) {
        return (this._totalMouseMoves >= MOUSE_MOVES_REQUIRED) === rule.value;
    };

    return Test;

});


/**
 * Tests if the window dimensions match certain expectations
 * @module tests/Window
 */
define('tests/Window',['Conditioner'],function(Conditioner){

    

    var Test = Conditioner.Test.inherit(),
    p = Test.prototype;

    p.handleEvent = function(e) {
        this.assert();
    };

    p.arrange = function() {
        window.addEventListener('resize',this,false);
    };

    p._test = function(rule) {

        var innerWidth = window.innerWidth || document.documentElement.clientWidth;

        switch(rule.key) {
            case 'min-width':{
                return innerWidth >= rule.value;
            }
            case 'max-width':{
                return innerWidth <= rule.value;
            }
        }

        return true;
    };

    return Test;

});

define('ui/Clock',['Conditioner'],function(Conditioner){

    

    // reference to parent class
    var _parent = Conditioner.Module;

    // Clock Class
    var Clock = function(element,options) {

        // set default options
        this._options = {
            'time':true
        };

        // call BehaviourBase constructor
        _parent.call(this,element,options);

        // backup content
        this._inner = this._element.innerHTML;

        // start ticking
        this._tick();
    };

    // Extend from BehaviourBase
    var p = Clock.prototype = Object.create(_parent.prototype);

    // Update time
    p._tick = function() {

        var self = this,
            pad = function(n){return n<10 ? '0'+n : n},
            now = new Date(),
            date = pad(now.getDate()) + '/' + (now.getMonth()+1) + '/'+ now.getFullYear(),
            time = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());

        // write inner html
        this._element.innerHTML = date + (this._options.time ? ' - ' + time : '');

        // if time is not enabled, don't start ticking
        if (!this._options.time) {
            return;
        }

        // wait timeout milliseconds till next clock tick
        this._timer = setTimeout(function(){
            self._tick();
        },900);

    };

    // Unload Clock behaviour
    p._unload = function() {

        // call BehaviourBase unload method
        _parent.prototype._unload.call(this);

        // stop ticking
        clearTimeout(this._timer);

        // restore content
        this._element.innerHTML = this._inner;
    };

    return Clock;

});
define('ui/StorageConsentSelect',['Conditioner','security/StorageConsentGuard'],function(Conditioner,IStorageGuard){

    

    // reference to parent class
    var _parent = Conditioner.Module;

    // StorageConsentSelect Class
    var StorageConsentSelect = function(element,options) {

        // default options for this class
        this._options = {
            'label':{
                'select':'Cookies',
                'level':{
                    'all':'All',
                    'none':'None'
                }
            }
        };

        // Call BehaviourBase constructor
        _parent.call(this,element,options);

        // set reference to storage guard
        this._storageGuard = IStorageGuard.getInstance();

        // store inner HTML
        this._inner = this._element.innerHTML;

        // options
        var level,levels = this._options.label.level,html = '';
        for (level in levels) {
            if (!levels.hasOwnProperty(level)) {
                continue;
            }
            html += '<option' + (level == this._storageGuard.getActiveLevel() ? ' selected="selected"': '') + ' value="' + level + '">' + this._options.label.level[level] + '</option>';
        }

        // setup select
        this._element.innerHTML = '<label for="storage-consent">' + this._options.label.select + '</label>' +
                                  '<select id="storage-consent">' + html + '</select>';

        // listen to changes on select
        this._element.querySelector('select').addEventListener('change',this);

    };

    // Extend from BehaviourBase
    var p = StorageConsentSelect.prototype = Object.create(_parent.prototype);

    // Handle events
    p.handleEvent = function(e) {
        if (e.type === 'change') {
            var select = this._element.querySelector('select'),
                value = select.options[select.selectedIndex].value;

            // set active level
            this._storageGuard.setActiveLevel(value);
        }
    };

    // Unload StorageConsentSelect behaviour
    p._unload = function() {

        // call BehaviourBase unload method
        _parent.prototype._unload.call(this);

        // remove event listener
        this._element.querySelector('select').removeEventListener('change',this);

        // restore original content
        this._element.innerHTML = this._inner;

    };

    return StorageConsentSelect;

});