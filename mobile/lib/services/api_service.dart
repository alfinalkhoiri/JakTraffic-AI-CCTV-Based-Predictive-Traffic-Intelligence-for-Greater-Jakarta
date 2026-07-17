import 'dart:convert';
import 'package:http/http.dart' as http;

class ApiService {
  static const String baseUrl = 'https://jaktrafficai.f-mc.my.id';
  static final http.Client _client = http.Client();

  static Future<dynamic> get(String endpoint, {Map<String, String>? params}) async {
    final uri = Uri.parse('$baseUrl$endpoint').replace(queryParameters: params);
    try {
      final response = await _client.get(uri).timeout(const Duration(seconds: 15));
      if (response.statusCode == 200) {
        return json.decode(response.body);
      }
      throw ApiException('HTTP ${response.statusCode}', response.statusCode);
    } catch (e) {
      if (e is ApiException) rethrow;
      throw ApiException('Network error: $e', 0);
    }
  }

  static Future<dynamic> post(String endpoint, {Map<String, dynamic>? body}) async {
    final uri = Uri.parse('$baseUrl$endpoint');
    try {
      final response = await _client.post(
        uri,
        headers: {'Content-Type': 'application/json'},
        body: json.encode(body ?? {}),
      ).timeout(const Duration(seconds: 30));
      if (response.statusCode == 200) {
        return json.decode(response.body);
      }
      throw ApiException('HTTP ${response.statusCode}', response.statusCode);
    } catch (e) {
      if (e is ApiException) rethrow;
      throw ApiException('Network error: $e', 0);
    }
  }

  /// SSE streaming POST — yields text chunks from chat-stream endpoint.
  /// [onActions] receives the backend's map-control commands
  /// (`data: {"actions": [...]}` event) when present.
  static Stream<String> postStream(
    String endpoint, {
    Map<String, dynamic>? body,
    void Function(List<dynamic> actions)? onActions,
  }) async* {
    final uri = Uri.parse('$baseUrl$endpoint');
    final request = http.Request('POST', uri)
      ..headers['Content-Type'] = 'application/json'
      ..body = json.encode(body ?? {});

    try {
      final streamedResponse = await _client.send(request).timeout(const Duration(seconds: 120));
      if (streamedResponse.statusCode != 200) {
        throw ApiException('HTTP ${streamedResponse.statusCode}', streamedResponse.statusCode);
      }

      final stream = streamedResponse.stream
          .transform(utf8.decoder)
          .transform(const LineSplitter());

      await for (final line in stream) {
        if (!line.startsWith('data: ')) continue;
        final raw = line.substring(6).trim();
        if (raw.isEmpty) continue;
        try {
          final parsed = json.decode(raw);
          if (parsed is Map) {
            if (parsed.containsKey('chunk')) {
              yield parsed['chunk'] as String;
            }
            if (parsed['actions'] is List && onActions != null) {
              onActions(parsed['actions'] as List);
            }
            if (parsed['done'] == true) break;
            if (parsed.containsKey('error')) {
              yield '[Error] ${parsed['error']}';
              break;
            }
          }
        } catch (_) {
          continue;
        }
      }
    } catch (e) {
      if (e is ApiException) rethrow;
      throw ApiException('Stream error: $e', 0);
    }
  }
}

class ApiException implements Exception {
  final String message;
  final int statusCode;
  ApiException(this.message, this.statusCode);

  @override
  String toString() => 'ApiException($statusCode): $message';
}
