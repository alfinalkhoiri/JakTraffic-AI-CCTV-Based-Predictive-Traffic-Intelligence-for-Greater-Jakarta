import 'dart:convert';
import 'dart:math' as math;
import 'dart:ui';

import 'package:http/http.dart' as http;
import 'package:latlong2/latlong.dart';

import '../models/cctv_status.dart';
import '../theme/app_theme.dart';
import 'api_service.dart';

/// One turn-by-turn instruction from OSRM.
class RouteStep {
  final String type; // turn, depart, arrive, ...
  final String modifier; // left, right, straight, ...
  final String name; // street name
  final double distanceM;

  RouteStep({
    required this.type,
    required this.modifier,
    required this.name,
    required this.distanceM,
  });
}

class OsrmLeg {
  final double durationSec;
  final double distanceM;
  final List<RouteStep> steps;

  OsrmLeg({required this.durationSec, required this.distanceM, required this.steps});
}

class OsrmRoute {
  final List<LatLng> coords;
  final List<OsrmLeg> legs;

  OsrmRoute({required this.coords, required this.legs});
}

/// A named toll-road corridor polyline drawn as a permanent map overlay.
class TollCorridor {
  final String name;
  final Color color;
  final List<LatLng> points;

  TollCorridor({required this.name, required this.color, required this.points});
}

/// OSRM public-server routing + traffic heuristics, ported from the React
/// frontend (frontend/src/App.js) so both clients behave the same.
class RouteService {
  static const String _osrmBase = 'https://router.project-osrm.org/route/v1/driving';
  static final http.Client _client = http.Client();

  static double haversineMeters(double lat1, double lng1, double lat2, double lng2) {
    const r = 6371000.0;
    final dLat = (lat2 - lat1) * math.pi / 180;
    final dLng = (lng2 - lng1) * math.pi / 180;
    final a = math.pow(math.sin(dLat / 2), 2) +
        math.cos(lat1 * math.pi / 180) *
            math.cos(lat2 * math.pi / 180) *
            math.pow(math.sin(dLng / 2), 2);
    return r * 2 * math.atan2(math.sqrt(a), math.sqrt(1 - a));
  }

  /// Cameras within 200 m of the route line become intermediate waypoints
  /// (ignoring ones within 120 m of start/end), ordered along the route.
  static List<CctvStatus> detectIntermediateCctvs(
    List<LatLng> coords,
    List<CctvStatus> cctvList,
    LatLng start,
    LatLng end,
  ) {
    const threshold = 200.0;
    const exclRadius = 120.0;

    final candidates = <MapEntry<int, CctvStatus>>[];
    for (final c in cctvList) {
      if (haversineMeters(c.lat, c.lng, start.latitude, start.longitude) < exclRadius) continue;
      if (haversineMeters(c.lat, c.lng, end.latitude, end.longitude) < exclRadius) continue;
      var minDist = double.infinity;
      var minIdx = 0;
      for (var i = 0; i < coords.length; i++) {
        final d = haversineMeters(c.lat, c.lng, coords[i].latitude, coords[i].longitude);
        if (d < minDist) {
          minDist = d;
          minIdx = i;
        }
      }
      if (minDist < threshold) candidates.add(MapEntry(minIdx, c));
    }
    candidates.sort((a, b) => a.key.compareTo(b.key));
    return candidates.map((e) => e.value).toList();
  }

  static CctvStatus? findNearestCctv(LatLng point, List<CctvStatus> cctvList) {
    if (cctvList.isEmpty) return null;
    CctvStatus? nearest;
    var minDist = double.infinity;
    for (final c in cctvList) {
      final d = math.pow(point.latitude - c.lat, 2) + math.pow(point.longitude - c.lng, 2).toDouble();
      if (d < minDist) {
        minDist = d.toDouble();
        nearest = c;
      }
    }
    return nearest;
  }

  static Color trafficColor(int vehicles) {
    if (vehicles > 30) return AppColors.merah;
    if (vehicles > 15) return AppColors.kuning;
    return AppColors.hijau;
  }

  static double trafficMultiplier(int vehicles) {
    if (vehicles > 30) return 1.5;
    if (vehicles > 15) return 1.25;
    return 1.0;
  }

  /// Fetches a driving route through [waypoints] from the public OSRM server.
  static Future<OsrmRoute> fetchRoute(
    List<LatLng> waypoints, {
    bool excludeMotorway = false,
    bool withSteps = true,
  }) async {
    final wpStr = waypoints.map((w) => '${w.longitude},${w.latitude}').join(';');
    final exclude = excludeMotorway ? '&exclude=motorway' : '';
    final steps = withSteps ? '&steps=true' : '';
    final uri = Uri.parse(
      '$_osrmBase/$wpStr?overview=full&geometries=geojson$steps$exclude',
    );

    try {
      final response = await _client.get(uri).timeout(const Duration(seconds: 15));
      if (response.statusCode != 200) {
        throw ApiException('OSRM HTTP ${response.statusCode}', response.statusCode);
      }
      final data = json.decode(response.body);
      final routes = data['routes'];
      if (routes is! List || routes.isEmpty) {
        throw ApiException('OSRM: rute tidak ditemukan', 0);
      }
      final route = routes[0];

      final rawCoords = route['geometry']['coordinates'] as List;
      final coords = rawCoords
          .map((c) => LatLng((c[1] as num).toDouble(), (c[0] as num).toDouble()))
          .toList();

      final legs = (route['legs'] as List? ?? []).map((leg) {
        final steps = (leg['steps'] as List? ?? []).map((s) {
          final maneuver = s['maneuver'] ?? {};
          return RouteStep(
            type: maneuver['type']?.toString() ?? '',
            modifier: maneuver['modifier']?.toString() ?? 'straight',
            name: s['name']?.toString() ?? '',
            distanceM: (s['distance'] as num?)?.toDouble() ?? 0,
          );
        }).toList();
        return OsrmLeg(
          durationSec: (leg['duration'] as num?)?.toDouble() ?? 0,
          distanceM: (leg['distance'] as num?)?.toDouble() ?? 0,
          steps: steps,
        );
      }).toList();

      return OsrmRoute(coords: coords, legs: legs);
    } catch (e) {
      if (e is ApiException) rethrow;
      throw ApiException('Network error: $e', 0);
    }
  }

  /// Builds the 8 toll-road corridor overlays from toll cameras, mirroring
  /// the React frontend (frontend/src/App.js). Corridors whose fetch fails
  /// are silently skipped.
  static Future<List<TollCorridor>> fetchTollCorridors(List<CctvStatus> cctvList) async {
    final tollCams = cctvList.where((c) => c.roadType == 'toll').toList();
    if (tollCams.isEmpty) return [];

    List<CctvStatus> byName(String keyword) {
      final cams = tollCams.where((c) => c.name.contains(keyword)).toList()
        ..sort((a, b) => a.lng.compareTo(b.lng));
      return cams;
    }

    Future<TollCorridor?> corridor(List<CctvStatus> cams, Color color, String name) async {
      if (cams.length < 2) return null;
      // Cap at 10 waypoints so OSRM does not time out.
      final step = math.max(1, cams.length ~/ 10);
      final picks = <CctvStatus>[
        for (var i = 0; i < cams.length; i++)
          if (i % step == 0 || i == cams.length - 1) cams[i],
      ];
      try {
        final route = await fetchRoute(
          picks.map((c) => LatLng(c.lat, c.lng)).toList(),
          withSteps: false,
        );
        return TollCorridor(name: name, color: color, points: route.coords);
      } catch (_) {
        return null;
      }
    }

    final results = await Future.wait([
      corridor(byName('KG-PG'), const Color(0xFFF59E0B), 'Tol KG-PG — Kelapa Gading–Pulo Gebang'),
      corridor(byName('BCKM - '), const Color(0xFFFB923C), 'Tol BCKM — Cawang–Bekasi'),
      corridor(byName('BCKM Segmen'), const Color(0xFFF97316), 'Tol BCKM Segmen — Duren Sawit–Bekasi Barat'),
      corridor(byName('JORR W2'), const Color(0xFFA78BFA), 'Tol JORR W2 — Cengkareng–Ulujami'),
      corridor(byName('JORR E1'), const Color(0xFF34D399), 'Tol JORR E1 — Cilincing–Cibitung'),
      corridor(byName('JORR Selatan'), const Color(0xFF60A5FA), 'Tol JORR Selatan — Pondok Pinang–Cikunir'),
      corridor(byName('Tol Dalam Kota'), const Color(0xFFF472B6), 'Tol Dalam Kota'),
      corridor(byName('Tol Bekasi'), const Color(0xFF22D3EE), 'Tol Bekasi'),
    ]);

    return results.whereType<TollCorridor>().toList();
  }
}
