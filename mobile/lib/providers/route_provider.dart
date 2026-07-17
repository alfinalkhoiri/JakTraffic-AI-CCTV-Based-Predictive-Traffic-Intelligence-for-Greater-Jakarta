import 'package:flutter/material.dart';
import 'package:latlong2/latlong.dart';

import '../models/cctv_status.dart';
import '../services/route_service.dart';

/// One drawable route piece: contiguous points sharing a traffic color.
/// Dashed = outside any 400 m CCTV zone (color is an estimate from the
/// nearest camera), solid = inside a zone (color from the busiest camera).
class RouteSegment {
  final List<LatLng> points;
  final Color color;
  final bool dashed;

  RouteSegment({required this.points, required this.color, required this.dashed});
}

/// Per-leg ETA badge shown at intermediate cameras and the destination.
class WaypointEta {
  final LatLng point;
  final int segmentMin;
  final String segmentKm;
  final bool isDestination;

  WaypointEta({
    required this.point,
    required this.segmentMin,
    required this.segmentKm,
    this.isDestination = false,
  });
}

/// Tap-to-tap routing state, mirroring the React frontend behavior:
/// 1st map tap sets the origin, 2nd sets the destination and fetches the
/// route, 3rd resets and starts a new origin.
class RouteProvider extends ChangeNotifier {
  LatLng? _start;
  LatLng? _end;
  List<RouteSegment> _segments = [];
  int? _etaMinutes;
  double? _distanceKm;
  List<RouteStep> _steps = [];
  List<WaypointEta> _waypointEtas = [];
  bool _isLoading = false;
  String? _error;

  // Kept so an error retry can re-run the same fetch.
  List<CctvStatus> _lastCctvList = [];
  bool _lastCityOnly = false;

  List<TollCorridor> _tollCorridors = [];
  bool _corridorsRequested = false;

  LatLng? get start => _start;
  LatLng? get end => _end;
  List<RouteSegment> get segments => _segments;
  int? get etaMinutes => _etaMinutes;
  double? get distanceKm => _distanceKm;
  List<RouteStep> get steps => _steps;
  List<WaypointEta> get waypointEtas => _waypointEtas;
  List<TollCorridor> get tollCorridors => _tollCorridors;
  bool get isLoading => _isLoading;
  String? get error => _error;
  bool get hasRoute => _segments.isNotEmpty;

  /// Loads the toll corridor overlays once, the first time camera data is
  /// available. Safe to call from build (guarded, async).
  Future<void> ensureTollCorridors(List<CctvStatus> cctvList) async {
    if (_corridorsRequested || cctvList.isEmpty) return;
    _corridorsRequested = true;
    try {
      _tollCorridors = await RouteService.fetchTollCorridors(cctvList);
      if (_tollCorridors.isNotEmpty) notifyListeners();
    } catch (_) {
      // Overlay is cosmetic — ignore failures, allow a later retry.
      _corridorsRequested = false;
    }
  }

  /// Programmatic route (e.g. from a chatbot map command).
  void setRoute(LatLng start, LatLng end, List<CctvStatus> cctvList, {bool cityOnly = false}) {
    _start = start;
    _end = end;
    _lastCctvList = cctvList;
    _lastCityOnly = cityOnly;
    notifyListeners();
    _fetchRoute();
  }

  void onMapTap(LatLng point, List<CctvStatus> cctvList, {required bool cityOnly}) {
    if (_start == null) {
      _start = point;
      notifyListeners();
    } else if (_end == null) {
      _end = point;
      _lastCctvList = cctvList;
      _lastCityOnly = cityOnly;
      notifyListeners();
      _fetchRoute();
    } else {
      clear(notify: false);
      _start = point;
      notifyListeners();
    }
  }

  /// Called when the user drags the origin/destination pin to a new spot.
  /// Refetches the route only when both endpoints exist.
  void moveEndpoint({
    LatLng? start,
    LatLng? end,
    required List<CctvStatus> cctvList,
    required bool cityOnly,
  }) {
    if (start != null) _start = start;
    if (end != null) _end = end;
    if (_start != null && _end != null) {
      _lastCctvList = cctvList;
      _lastCityOnly = cityOnly;
      _fetchRoute();
    }
    notifyListeners();
  }

  void retry() {
    if (_start != null && _end != null) _fetchRoute();
  }

  void clear({bool notify = true}) {
    _start = null;
    _end = null;
    _segments = [];
    _etaMinutes = null;
    _distanceKm = null;
    _steps = [];
    _waypointEtas = [];
    _isLoading = false;
    _error = null;
    if (notify) notifyListeners();
  }

  Future<void> _fetchRoute() async {
    final start = _start;
    final end = _end;
    if (start == null || end == null) return;

    _isLoading = true;
    _error = null;
    notifyListeners();

    try {
      final cctvList = _lastCctvList;

      // Step 1: initial A→B fetch for geometry.
      var route = await RouteService.fetchRoute(
        [start, end],
        excludeMotorway: _lastCityOnly,
      );

      // Step 2-3: reroute through cameras that lie along the way.
      final intermediates =
          RouteService.detectIntermediateCctvs(route.coords, cctvList, start, end);
      if (intermediates.isNotEmpty) {
        route = await RouteService.fetchRoute(
          [start, ...intermediates.map((c) => LatLng(c.lat, c.lng)), end],
          excludeMotorway: _lastCityOnly,
        );
      }

      // Bail out if the user reset/re-tapped while we were fetching.
      if (_start != start || _end != end) return;

      // Step 4: traffic-coloured segments (solid within a 400 m camera zone,
      // dashed estimate elsewhere).
      _segments = _buildSegments(route.coords, cctvList);

      // Step 5: ETA = sum of leg durations × nearest-camera traffic
      // multiplier, plus per-leg badges at intermediate cameras (and the
      // destination, but only when intermediates exist — website parity).
      final allWaypoints = [start, ...intermediates.map((c) => LatLng(c.lat, c.lng)), end];
      var totalMin = 0;
      var totalKm = 0.0;
      final badges = <WaypointEta>[];
      for (var i = 0; i < route.legs.length; i++) {
        final mid = LatLng(
          (allWaypoints[i].latitude + allWaypoints[i + 1].latitude) / 2,
          (allWaypoints[i].longitude + allWaypoints[i + 1].longitude) / 2,
        );
        final midCctv = RouteService.findNearestCctv(mid, cctvList);
        final mult = midCctv != null ? RouteService.trafficMultiplier(midCctv.vehicles) : 1.0;
        final legMin = ((route.legs[i].durationSec / 60) * mult).round();
        final legKm = (route.legs[i].distanceM / 1000).toStringAsFixed(1);
        totalMin += legMin;
        totalKm += route.legs[i].distanceM / 1000;

        if (i < intermediates.length) {
          badges.add(WaypointEta(
            point: LatLng(intermediates[i].lat, intermediates[i].lng),
            segmentMin: legMin,
            segmentKm: legKm,
          ));
        } else if (intermediates.isNotEmpty) {
          badges.add(WaypointEta(
            point: end,
            segmentMin: legMin,
            segmentKm: legKm,
            isDestination: true,
          ));
        }
      }
      _waypointEtas = badges;
      _etaMinutes = totalMin;
      _distanceKm = totalKm;

      // Step 6: flatten turn-by-turn steps across legs.
      _steps = route.legs.expand((l) => l.steps).toList();
    } catch (e) {
      _error = e.toString();
      _segments = [];
      _etaMinutes = null;
      _distanceKm = null;
      _steps = [];
      _waypointEtas = [];
    }

    _isLoading = false;
    notifyListeners();
  }

  List<RouteSegment> _buildSegments(List<LatLng> coords, List<CctvStatus> cctvList) {
    if (coords.isEmpty) return [];
    const zoneRadius = 400.0;

    ({Color color, bool dashed}) styleAt(LatLng p) {
      final inZone = cctvList
          .where((c) =>
              RouteService.haversineMeters(p.latitude, p.longitude, c.lat, c.lng) <= zoneRadius)
          .toList();
      if (inZone.isNotEmpty) {
        final worst = inZone.reduce((a, b) => a.vehicles >= b.vehicles ? a : b);
        return (color: RouteService.trafficColor(worst.vehicles), dashed: false);
      }
      final nearest = RouteService.findNearestCctv(p, cctvList);
      return (
        color: nearest != null ? RouteService.trafficColor(nearest.vehicles) : Colors.blueGrey,
        dashed: true,
      );
    }

    final segments = <RouteSegment>[];
    var cur = styleAt(coords[0]);
    var curPoints = <LatLng>[coords[0]];
    for (var i = 1; i < coords.length; i++) {
      final s = styleAt(coords[i]);
      if (s.color != cur.color || s.dashed != cur.dashed) {
        curPoints.add(coords[i]);
        segments.add(RouteSegment(points: List.of(curPoints), color: cur.color, dashed: cur.dashed));
        curPoints = [coords[i]];
        cur = s;
      } else {
        curPoints.add(coords[i]);
      }
    }
    if (curPoints.length > 1) {
      segments.add(RouteSegment(points: curPoints, color: cur.color, dashed: cur.dashed));
    }
    return segments;
  }
}
