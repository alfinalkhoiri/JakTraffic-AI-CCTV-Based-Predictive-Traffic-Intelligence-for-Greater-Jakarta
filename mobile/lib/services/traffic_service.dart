import '../models/cctv_status.dart';
import '../models/prediction.dart';
import 'api_service.dart';

class TrafficService {
  static Future<List<CctvStatus>> fetchCctvStatus() async {
    final data = await ApiService.get('/api/cctv_status');
    if (data is List) {
      return data.map((json) => CctvStatus.fromJson(json)).toList();
    }
    return [];
  }

  static Future<List<Prediction>> fetchPredictions({String horizon = '15'}) async {
    final data = await ApiService.get(
      '/api/predict-traffic',
      params: {'horizon': horizon},
    );
    if (data is Map && data['predictions'] is List) {
      return (data['predictions'] as List)
          .map((json) => Prediction.fromJson(json))
          .toList();
    }
    return [];
  }

  static Future<Map<String, dynamic>> fetchSimTimeRange() async {
    final data = await ApiService.get('/api/sim-time-range');
    return data is Map<String, dynamic> ? data : {};
  }

  static Future<Map<String, dynamic>> setSimTime(String timestamp) async {
    final data = await ApiService.post(
      '/api/set-sim-time',
      body: {'timestamp': timestamp},
    );
    return data is Map<String, dynamic> ? data : {};
  }

  static Future<List<Map<String, dynamic>>> fetchTomtomIncidents() async {
    try {
      final data = await ApiService.get('/api/tomtom-incidents');
      if (data is List) {
        return data.cast<Map<String, dynamic>>();
      }
    } catch (_) {}
    return [];
  }
}
