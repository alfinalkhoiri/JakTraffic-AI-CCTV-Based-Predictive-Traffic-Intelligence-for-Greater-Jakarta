import '../models/chat_message.dart';
import 'api_service.dart';

class ChatService {
  static Future<String> sendMessage(
    String message,
    List<ChatMessage> history,
  ) async {
    final data = await ApiService.post('/api/chat', body: {
      'message': message,
      'mode': 'chat',
      'history': history.map((m) => m.toJson()).toList(),
    });
    return data['reply'] ?? '(Tidak ada respons)';
  }

  static Stream<String> sendMessageStream(
    String message,
    List<ChatMessage> history, {
    void Function(List<dynamic> actions)? onActions,
  }) {
    return ApiService.postStream(
      '/api/chat-stream',
      body: {
        'message': message,
        'history': history.map((m) => m.toJson()).toList(),
      },
      onActions: onActions,
    );
  }

  static Future<bool> checkLlmStatus() async {
    try {
      final data = await ApiService.get('/api/llm-status');
      return data['online'] == true;
    } catch (_) {
      return false;
    }
  }
}
