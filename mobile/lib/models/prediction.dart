class Prediction {
  final int locationId;
  final String name;
  final double? lat;
  final double? lng;
  final int currentVehicles;
  final int predictedVehicles;
  final String status;

  Prediction({
    required this.locationId,
    required this.name,
    this.lat,
    this.lng,
    required this.currentVehicles,
    required this.predictedVehicles,
    required this.status,
  });

  factory Prediction.fromJson(Map<String, dynamic> json) {
    return Prediction(
      locationId: json['location_id'] ?? 0,
      name: json['name'] ?? '',
      lat: json['lat']?.toDouble(),
      lng: json['lng']?.toDouble(),
      currentVehicles: json['current_vehicles'] ?? 0,
      predictedVehicles: json['predicted_vehicles'] ?? 0,
      status: json['status'] ?? 'LANCAR',
    );
  }

  int get delta => predictedVehicles - currentVehicles;

  double get changePct =>
      currentVehicles > 0 ? (delta / currentVehicles) * 100 : 0;

  String get statusLabel {
    switch (status.toUpperCase()) {
      case 'PADAT':
        return 'Padat';
      case 'RAMAI':
        return 'Ramai';
      case 'LANCAR':
        return 'Lancar';
      default:
        return status;
    }
  }
}
