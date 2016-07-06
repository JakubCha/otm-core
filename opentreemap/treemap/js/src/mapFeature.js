"use strict";

var $ = require('jquery'),
    _ = require('lodash'),
    toastr = require('toastr'),
    inlineEditForm = require('treemap/lib/inlineEditForm.js'),
    MapManager = require('treemap/lib/MapManager.js'),
    R = require('ramda'),
    BU = require('treemap/lib/baconUtils.js'),
    Bacon = require('baconjs'),
    U = require('treemap/lib/utility.js'),
    geometryMover = require('treemap/lib/geometryMover.js'),
    plotMarker = require('treemap/lib/plotMarker.js'),
    statePrompter = require('treemap/lib/statePrompter.js'),
    csrf = require('treemap/lib/csrf.js'),
    imageUploadPanel = require('treemap/lib/imageUploadPanel.js'),
    socialMediaSharing = require('treemap/lib/socialMediaSharing.js'),
    reverseGeocodeStreamAndUpdateAddressesOnForm =
        require('treemap/lib/reverseGeocodeStreamAndUpdateAddressesOnForm.js'),
    streetView = require('treemap/lib/streetView.js'),
    alerts = require('treemap/lib/alerts.js'),

    dom = {
        favoriteLink: '#favorite-link',
        favoriteIcon: '#favorite-star'
    };

exports.init = function(options) {
    var $ecoBenefits = $(options.ecoBenefits),
        detailUrl = window.location.href;

    if (U.getLastUrlSegment(detailUrl) == 'edit') {
        detailUrl = U.removeLastUrlSegment(detailUrl);
    }

    // Set up cross-site forgery protection
    $.ajaxSetup(csrf.jqueryAjaxSetupOptions);

    var prompter = statePrompter.init({
        warning: options.config.trans.exitWarning,
        question: options.config.trans.exitQuestion
    });

    var imageFinishedStream = imageUploadPanel.init(options.imageUploadPanel);

    var shouldBeInEditModeBus = new Bacon.Bus();
    var shouldBeInEditModeStream = shouldBeInEditModeBus.merge(
        $(window).asEventStream('popstate')
            .map(function() { return U.getLastUrlSegment() === 'edit'; }));

    var currentMover;

    var form = inlineEditForm.init(
            _.extend(options.inlineEditForm,
                     { config: options.config,
                       updateUrl: detailUrl,
                       shouldBeInEditModeStream: shouldBeInEditModeStream,
                       errorCallback: alerts.makeErrorCallback(options.config),
                       onSaveBefore: function (data) { currentMover.onSaveBefore(data); },
                       onSaveAfter: function (data) { currentMover.onSaveAfter(data); }
                     }));

    if (options.config.instance.supportsEcobenefits) {
        var updateEcoUrl = U.appendSegmentToUrl('eco', detailUrl);
        form.saveOkStream
            .map($ecoBenefits)
            .onValue('.load', updateEcoUrl);
    }

    var sidebarUpdate = form.saveOkStream.merge(imageFinishedStream),
        updateSidebarUrl = U.appendSegmentToUrl('sidebar', detailUrl);
    sidebarUpdate
        .map($(options.sidebar))
        .onValue('.load', updateSidebarUrl);

    form.inEditModeProperty.onValue(function(inEditMode) {
        var hrefHasEdit = U.getLastUrlSegment() === 'edit';

        if (inEditMode) {
            prompter.lock();
            if (!hrefHasEdit) {
                history.replaceState(null, document.title, U.appendSegmentToUrl('edit'));
            }
        } else {
            prompter.unlock();
            if (hrefHasEdit) {
                history.replaceState(null, document.title, U.removeLastUrlSegment());
            }
        }
    });

    if (options.startInEditMode) {
        if (options.config.loggedIn) {
            shouldBeInEditModeBus.push(true);
        } else {
            window.location = options.config.loginUrl + window.location.href;
        }
    }

    var mapManager = new MapManager();
    mapManager.createTreeMap({
        config: options.config,
        domId: 'map',
        disableScrollWithMouseWheel: true,
        centerWM: options.location.point,
        zoom: mapManager.ZOOM_PLOT
    });

    var moverOptions = {
        mapManager: mapManager,
        inlineEditForm: form,
        editLocationButton: options.location.edit,
        cancelEditLocationButton: options.location.cancel,
        location: options.location,
        config: options.config,
        resourceType: options.resourceType
    };

    if (options.isEditablePolygon) {
        currentMover = geometryMover.polygonMover(moverOptions);
    } else {
        plotMarker.init(options.config, mapManager.map);
        plotMarker.useTreeIcon(options.useTreeIcon);
        reverseGeocodeStreamAndUpdateAddressesOnForm(
            options.config, plotMarker.moveStream, options.form);
        moverOptions.plotMarker = plotMarker;
        currentMover = geometryMover.plotMover(moverOptions);
    }

    var detailUrlPrefix = U.removeLastUrlSegment(detailUrl),
        clickedIdStream = mapManager.map.utfEvents
            .map('.data.' + options.config.utfGrid.mapfeatureIdKey)
            .filter(BU.isDefinedNonEmpty);

    clickedIdStream
        .filter(BU.not, options.featureId)
        .map(_.partialRight(U.appendSegmentToUrl, detailUrlPrefix, false))
        .filter(R.not(currentMover.isEnabled))
        .onValue(_.bind(window.location.assign, window.location));

    if (options.config.instance.basemap.type === 'google') {
        var $streetViewContainer = $(options.streetView);
        $streetViewContainer.show();
        var panorama = streetView.create({
            streetViewElem: $streetViewContainer[0],
            noStreetViewText: options.config.trans.noStreetViewText,
            location: options.location.point
        });
        form.saveOkStream
            .map('.formData')
            .map(BU.getValueForKey('plot.geom'))
            .filter(BU.isDefined)
            .onValue(panorama.update);
    }

    var $favoriteLink = $(dom.favoriteLink),
        $favoriteIcon = $(dom.favoriteIcon);

    if (options.config.loggedIn) {
        $favoriteLink.on('click', function(e) {
            var wasFavorited = $favoriteLink.attr('data-is-favorited') === 'True',
                url = $favoriteLink.attr(wasFavorited ? 'data-unfavorite-url' : 'data-favorite-url');

            $.ajax({
                dataType: "json",
                url: url,
                type: 'POST'
            })
            .done(function(response) {
                // Flip classes and is-favorited attribute if request succeeded
                if (wasFavorited) {
                    $favoriteIcon.addClass('icon-star-empty');
                    $favoriteIcon.removeClass('icon-star');
                    $favoriteLink.attr('data-is-favorited', 'False');
                } else {
                    $favoriteIcon.removeClass('icon-star-empty');
                    $favoriteIcon.addClass('icon-star');
                    $favoriteLink.attr('data-is-favorited', 'True');
                }
            })
            .fail(function() {
                toastr.error('Could not save your favorite');
            });

            e.preventDefault();
        });
    }

    socialMediaSharing.init(
        _.extend(options, {imageFinishedStream: imageFinishedStream}));

    return {
        inlineEditForm: form
    };
};
