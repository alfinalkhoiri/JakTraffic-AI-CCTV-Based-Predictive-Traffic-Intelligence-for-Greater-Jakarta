import 'dart:async';
import 'package:flutter/material.dart';
import '../models/chat_message.dart';
import '../models/map_action.dart';
import '../services/chat_service.dart';

class ChatProvider extends ChangeNotifier {
  final List<ChatMessage> _messages = [];
  bool _isLoading = false;
  bool _isLlmOnline = false;
  StreamSubscription? _streamSub;
  List<MapAction>? _pendingMapActions;

  List<ChatMessage> get messages => List.unmodifiable(_messages);
  bool get isLoading => _isLoading;
  bool get isLlmOnline => _isLlmOnline;

  /// Map commands from the last bot reply, waiting to be applied to the map.
  List<MapAction>? get pendingMapActions => _pendingMapActions;

  List<MapAction>? consumeMapActions() {
    final actions = _pendingMapActions;
    _pendingMapActions = null;
    return actions;
  }

  Future<void> checkLlmStatus() async {
    _isLlmOnline = await ChatService.checkLlmStatus();
    notifyListeners();
  }

  Future<void> sendMessage(String text) async {
    if (text.trim().isEmpty || _isLoading) return;

    // Add user message
    _messages.add(ChatMessage(role: 'user', content: text.trim()));
    notifyListeners();

    // Add placeholder assistant message
    _messages.add(ChatMessage(
      role: 'assistant',
      content: '',
      isStreaming: true,
    ));
    _isLoading = true;
    notifyListeners();

    try {
      final buffer = StringBuffer();
      final receivedActions = <MapAction>[];
      final stream = ChatService.sendMessageStream(
        text.trim(),
        _messages.where((m) => !m.isStreaming).toList(),
        onActions: (actions) {
          receivedActions.addAll(
            actions.whereType<Map>().map(
                  (a) => MapAction.fromJson(Map<String, dynamic>.from(a)),
                ),
          );
        },
      );

      _streamSub = stream.listen(
        (chunk) {
          buffer.write(chunk);
          // Update the last message with accumulated content
          _messages[_messages.length - 1] = _messages.last.copyWith(
            content: buffer.toString(),
          );
          notifyListeners();
        },
        onDone: () {
          _messages[_messages.length - 1] = _messages.last.copyWith(
            isStreaming: false,
          );
          _isLoading = false;
          if (receivedActions.isNotEmpty) {
            _pendingMapActions = List.of(receivedActions);
          }
          notifyListeners();
        },
        onError: (e) {
          _messages[_messages.length - 1] = _messages.last.copyWith(
            content: buffer.isEmpty
                ? 'Maaf, terjadi kesalahan: $e'
                : buffer.toString(),
            isStreaming: false,
          );
          _isLoading = false;
          notifyListeners();
        },
      );
    } catch (e) {
      _messages[_messages.length - 1] = _messages.last.copyWith(
        content: 'Maaf, gagal menghubungi server: $e',
        isStreaming: false,
      );
      _isLoading = false;
      notifyListeners();
    }
  }

  void clearMessages() {
    _streamSub?.cancel();
    _messages.clear();
    _isLoading = false;
    notifyListeners();
  }

  @override
  void dispose() {
    _streamSub?.cancel();
    super.dispose();
  }
}
