import 'package:flutter/material.dart';
import '../models/prediction.dart';
import '../services/traffic_service.dart';

class PredictionProvider extends ChangeNotifier {
  List<Prediction> _predictions = [];
  bool _isLoading = false;
  String? _error;
  String _horizon = '15'; // '15' or '30'

  List<Prediction> get predictions => _predictions;
  bool get isLoading => _isLoading;
  String? get error => _error;
  String get horizon => _horizon;

  int get padatCount => _predictions.where((p) => p.status == 'PADAT').length;
  int get ramaiCount => _predictions.where((p) => p.status == 'RAMAI').length;
  int get lancarCount => _predictions.where((p) => p.status == 'LANCAR').length;

  void setHorizon(String h) {
    if (h != _horizon) {
      _horizon = h;
      fetchPredictions();
    }
  }

  Future<void> fetchPredictions() async {
    _isLoading = true;
    _error = null;
    notifyListeners();

    try {
      _predictions = await TrafficService.fetchPredictions(horizon: _horizon);
      // Sort by predicted vehicles descending
      _predictions.sort((a, b) => b.predictedVehicles.compareTo(a.predictedVehicles));
      _error = null;
    } catch (e) {
      _error = e.toString();
    }

    _isLoading = false;
    notifyListeners();
  }
}
