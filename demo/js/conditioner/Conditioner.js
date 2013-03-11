/**
 * @module conditioner/Conditioner
 */
var Conditioner = (function(Injector,BehaviorController) {

    'use strict';


    /**
     * Tests
     */
    var Tests = {

        _tests:[],

        registerTest:function(key,arrange,assert) {

            var test = this._tests[key] = {};
                test.arrange = arrange;
                test.assert = assert;


        },

        getTestByKey:function(key) {
            return this._tests[key];
        }

    };



    /**
     * @class Conditioner (Singleton)
     * @constructor
     */
    var Conditioner = function() {
        this._controllers = [];
    };

    var p = Conditioner.prototype;





    /**
     * @method registerTest
     * @param {string} key - Test identifier
     * @param {function} arrange - Test arrange method
     * @param {function} assert - Test assert method
     */
    p.registerTest = function(key,arrange,assert) {

        if (!key) {
            throw new Error('Conditioner.registerTest(key,arrange,assert): "key" is a required parameter.');
        }

        Tests.registerTest(key,arrange,assert);
    };

    /**
     * @method getTestByKey
     * @param {string} key - Test identifier
     * @return {Object} a Test
     */
    p.getTestByKey = function(key) {

        if (!key) {
            throw new Error('Conditioner.getTestByKey(key): "key" is a required parameter.');
        }

        return Tests.getTestByKey(key);
    };





    /**
     * Register multiple dependencies
     * @method registerDependencies
     */
    p.registerDependencies = function() {
        var dependency,i=0,l=arguments.length;
        for (;i<l;i++) {
            dependency = arguments[i];
            Injector.registerDependency(dependency.id,dependency.uri,dependency.options);
        }
    };


    /**
     * @method registerDependency
     * @param {String} id - identifier (interface) of Class
     * @param {String} uri - class path
     * @param {Object} options - options to pass to instance
     */
    p.registerDependency = function(id,uri,options) {
        Injector.registerDependency(id,uri,options);
    };



    /**
     * Applies behavior on object within given context.
     *
     * @method applyBehavior
     * @param {Node} context - Context to apply behavior to
     * @return {Array} - Array of initialized BehaviorControllers
     */
    p.applyBehavior = function(context) {

        // if no context supplied throw error
        if (!context) {
            throw new Error('Conditioner.applyBehavior(context,options): "context" is a required parameter.');
        }

        // register vars and get elements
        var controllers = [],controller,
            priorityList = [],priorityLevel,
            behavior,behaviorId,
            element,elements = context.querySelectorAll('[data-behavior]:not([data-processed])',context),
            i=0,l = elements.length;

        // if no elements do nothing
        if (!elements) {
            return [];
        }

        // process elements
        for (; i<l; i++) {

            // set element reference
            element = elements[i];

            // has been processed
            element.setAttribute('data-processed','true');

            // get behavior path from element
            behaviorId = element.getAttribute('data-behavior');

            // get priority attribute
            priorityLevel = parseInt(element.getAttribute('data-priority'),10) || 0;

            // create instance
            controller = new BehaviorController(
                behaviorId,
                {
                    'target':element,
                    'conditions':element.getAttribute('data-conditions')
                }
            );

            // feed to controller
            priorityList.push({
                'controller':controller,
                'priority':priorityLevel
            });

            // add to controllers
            controllers.push(controller);
        }

        // sort controllers by priority:
        // higher numbers go first,
        // then 0 (or no priority assigned),
        // then negative numbers
        priorityList.sort(function(a,b){
            return b.priority - a.priority;
        });

        // initialize behavior depending on assigned priority
        for (i=0; i<l; i++) {
            priorityList[i].controller.init();
        }

        // merge new controllers with current controllers
        this._controllers = this._controllers.concat(controllers);

        // returns copy of controllers so it is possible to later unload behavior manually if necessary
        return controllers;
    };


    /**
     * Returns BehaviorControllers matching the selector
     *
     * @method getBehavior
     * @param {Object} query - Query to match the controller to, could be ClassPath, Element or CSS Selector
     * @return {Object} controller - First matched BehaviorController
     */
    p.getBehavior = function(query) {
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
     * Returns all BehaviorControllers matching the selector
     *
     * @method getBehaviorAll
     * @param {Object} query - Query to match the controller to, could be ClassPath, Element or CSS Selector
     * @return {Array} results - Array containing matched behavior controllers
     */
    p.getBehaviorAll = function(query) {
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
        }

    };

}(conditioner.Injector,conditioner.BehaviorController));