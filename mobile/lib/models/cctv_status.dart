class CctvStatus {
  final int id;
  final String name;
  final double lat;
  final double lng;
  final int vehicles;
  final String status;
  final int riskScore;
  final String weather;
  final String streamUrl;
  final String previewUrl;
  final String roadType;
  final bool hasSignal;
  final String lastUpdate;

  CctvStatus({
    required this.id,
    required this.name,
    required this.lat,
    required this.lng,
    required this.vehicles,
    required this.status,
    required this.riskScore,
    required this.weather,
    required this.streamUrl,
    required this.previewUrl,
    required this.roadType,
    required this.hasSignal,
    required this.lastUpdate,
  });

  factory CctvStatus.fromJson(Map<String, dynamic> json) {
    return CctvStatus(
      id: json['id'] ?? 0,
      name: json['name'] ?? '',
      lat: (json['lat'] ?? 0).toDouble(),
      lng: (json['lng'] ?? 0).toDouble(),
      vehicles: json['vehicles'] ?? 0,
      status: json['status'] ?? 'HIJAU',
      riskScore: json['risk_score'] ?? 0,
      weather: json['weather'] ?? 'Cerah',
      streamUrl: json['stream_url'] ?? '',
      previewUrl: json['preview_url'] ?? '',
      roadType: json['road_type'] ?? 'city',
      hasSignal: json['has_signal'] ?? true,
      lastUpdate: json['last_update'] ?? '',
    );
  }

  bool get isToll => roadType == 'toll';
  bool get hasStream => previewUrl.isNotEmpty || streamUrl.isNotEmpty;
  String get effectiveStreamUrl => previewUrl.isNotEmpty ? previewUrl : streamUrl;

  String get statusLabel {
    switch (status.toUpperCase()) {
      case 'MERAH':
        return 'Padat';
      case 'KUNING':
        return 'Ramai';
      case 'HIJAU':
        return 'Lancar';
      default:
        return status;
    }
  }

  String get statusEmoji {
    switch (status.toUpperCase()) {
      case 'MERAH':
        return '🔴';
      case 'KUNING':
        return '🟡';
      case 'HIJAU':
        return '🟢';
      default:
        return '⚪';
    }
  }
}
