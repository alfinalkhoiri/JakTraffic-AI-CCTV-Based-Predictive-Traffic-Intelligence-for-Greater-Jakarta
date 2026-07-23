/// A map-control command emitted by the chatbot backend inside the
/// /api/chat-stream SSE stream (`data: {"actions": [...]}`), produced by
/// detect_map_actions() in backend/app.py. Types:
/// select_pin, highlight_pins, fly_to, set_route, clear_selection.
class MapAction {
  final String type;
  final int? locationId; // select_pin
  final List<int> locationIds; // highlight_pins
  final double? lat; // fly_to
  final double? lng;
  final double? zoom;
  final double? startLat; // set_route
  final double? startLng;
  final double? endLat;
  final double? endLng;

  MapAction({
    required this.type,
    this.locationId,
    this.locationIds = const [],
    this.lat,
    this.lng,
    this.zoom,
    this.startLat,
    this.startLng,
    this.endLat,
    this.endLng,
  });

  factory MapAction.fromJson(Map<String, dynamic> json) {
    return MapAction(
      type: json['type']?.toString() ?? '',
      locationId: (json['location_id'] as num?)?.toInt(),
      locationIds: (json['location_ids'] as List?)
              ?.map((e) => (e as num).toInt())
              .toList() ??
          const [],
      lat: (json['lat'] as num?)?.toDouble(),
      lng: (json['lng'] as num?)?.toDouble(),
      zoom: (json['zoom'] as num?)?.toDouble(),
      startLat: (json['start_lat'] as num?)?.toDouble(),
      startLng: (json['start_lng'] as num?)?.toDouble(),
      endLat: (json['end_lat'] as num?)?.toDouble(),
      endLng: (json['end_lng'] as num?)?.toDouble(),
    );
  }
}
