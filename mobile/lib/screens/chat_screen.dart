import 'package:flutter/material.dart';
import 'package:provider/provider.dart';
import '../providers/chat_provider.dart';
import '../theme/app_theme.dart';

class ChatScreen extends StatefulWidget {
  const ChatScreen({super.key});

  @override
  State<ChatScreen> createState() => _ChatScreenState();
}

class _ChatScreenState extends State<ChatScreen> {
  final _controller = TextEditingController();
  final _scrollController = ScrollController();

  final _quickActions = [
    'Mana yang paling macet?',
    'Prediksi 15 menit ke depan',
    'Bandingkan Senayan dan Menteng',
    'Rute dari Bekasi ke Sudirman',
  ];

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      context.read<ChatProvider>().checkLlmStatus();
    });
  }

  void _sendMessage() {
    final text = _controller.text.trim();
    if (text.isEmpty) return;
    _controller.clear();
    context.read<ChatProvider>().sendMessage(text);
    _scrollToBottom();
  }

  void _scrollToBottom() {
    Future.delayed(const Duration(milliseconds: 100), () {
      if (_scrollController.hasClients) {
        _scrollController.animateTo(
          _scrollController.position.maxScrollExtent,
          duration: const Duration(milliseconds: 300),
          curve: Curves.easeOut,
        );
      }
    });
  }

  @override
  void dispose() {
    _controller.dispose();
    _scrollController.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Consumer<ChatProvider>(
      builder: (context, chatProvider, _) {
        // Auto-scroll when streaming
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (chatProvider.isLoading) _scrollToBottom();
        });

        return Scaffold(
          backgroundColor: AppColors.background,
          body: SafeArea(
            child: Column(
              children: [
                // Header
                _buildHeader(chatProvider),

                // Messages
                Expanded(
                  child: chatProvider.messages.isEmpty
                      ? _buildEmptyState()
                      : ListView.builder(
                          controller: _scrollController,
                          padding: const EdgeInsets.fromLTRB(16, 8, 16, 8),
                          itemCount: chatProvider.messages.length,
                          itemBuilder: (context, index) {
                            final msg = chatProvider.messages[index];
                            return _ChatBubble(
                              isUser: msg.isUser,
                              content: msg.content,
                              isStreaming: msg.isStreaming,
                            );
                          },
                        ),
                ),

                // Input
                _buildInput(chatProvider),
              ],
            ),
          ),
        );
      },
    );
  }

  Widget _buildHeader(ChatProvider provider) {
    return Container(
      padding: const EdgeInsets.fromLTRB(16, 12, 16, 12),
      decoration: const BoxDecoration(
        border: Border(bottom: BorderSide(color: AppColors.divider)),
      ),
      child: Row(
        children: [
          Container(
            padding: const EdgeInsets.all(8),
            decoration: BoxDecoration(
              color: AppColors.primary.withOpacity(0.1),
              borderRadius: BorderRadius.circular(10),
            ),
            child: const Icon(Icons.smart_toy, color: AppColors.primary, size: 20),
          ),
          const SizedBox(width: 10),
          const Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  'Traffic AI Assistant',
                  style: TextStyle(
                    color: AppColors.textPrimary,
                    fontSize: 16,
                    fontWeight: FontWeight.w600,
                  ),
                ),
                Text(
                  'Powered by SumoPod AI',
                  style: TextStyle(color: AppColors.textMuted, fontSize: 11),
                ),
              ],
            ),
          ),
          // LLM status
          Container(
            padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
            decoration: BoxDecoration(
              color: (provider.isLlmOnline ? AppColors.hijau : AppColors.merah).withOpacity(0.1),
              borderRadius: BorderRadius.circular(8),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Container(
                  width: 6,
                  height: 6,
                  decoration: BoxDecoration(
                    color: provider.isLlmOnline ? AppColors.hijau : AppColors.merah,
                    shape: BoxShape.circle,
                  ),
                ),
                const SizedBox(width: 4),
                Text(
                  provider.isLlmOnline ? 'Online' : 'Offline',
                  style: TextStyle(
                    color: provider.isLlmOnline ? AppColors.hijau : AppColors.merah,
                    fontSize: 10,
                    fontWeight: FontWeight.w600,
                  ),
                ),
              ],
            ),
          ),
          const SizedBox(width: 6),
          IconButton(
            onPressed: () => provider.clearMessages(),
            icon: const Icon(Icons.delete_outline, color: AppColors.textMuted, size: 20),
            tooltip: 'Hapus chat',
          ),
        ],
      ),
    );
  }

  Widget _buildEmptyState() {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(24),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Container(
              padding: const EdgeInsets.all(20),
              decoration: BoxDecoration(
                color: AppColors.primary.withOpacity(0.08),
                shape: BoxShape.circle,
              ),
              child: const Icon(Icons.smart_toy, color: AppColors.primary, size: 48),
            ),
            const SizedBox(height: 16),
            const Text(
              'Halo! 👋',
              style: TextStyle(color: AppColors.textPrimary, fontSize: 22, fontWeight: FontWeight.w700),
            ),
            const SizedBox(height: 6),
            const Text(
              'Tanyakan kondisi lalu lintas Jakarta & Bekasi',
              style: TextStyle(color: AppColors.textSecondary, fontSize: 13),
              textAlign: TextAlign.center,
            ),
            const SizedBox(height: 24),
            Wrap(
              spacing: 8,
              runSpacing: 8,
              alignment: WrapAlignment.center,
              children: _quickActions.map((action) {
                return GestureDetector(
                  onTap: () {
                    _controller.text = action;
                    _sendMessage();
                  },
                  child: Container(
                    padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
                    decoration: BoxDecoration(
                      color: AppColors.surface,
                      borderRadius: BorderRadius.circular(20),
                      border: Border.all(color: AppColors.divider),
                    ),
                    child: Text(
                      action,
                      style: const TextStyle(color: AppColors.primary, fontSize: 12),
                    ),
                  ),
                );
              }).toList(),
            ),
          ],
        ),
      ),
    );
  }

  Widget _buildInput(ChatProvider provider) {
    return Container(
      padding: const EdgeInsets.fromLTRB(12, 8, 8, 12),
      decoration: const BoxDecoration(
        color: AppColors.background,
        border: Border(top: BorderSide(color: AppColors.divider)),
      ),
      child: Row(
        children: [
          Expanded(
            child: Container(
              decoration: BoxDecoration(
                color: AppColors.surface,
                borderRadius: BorderRadius.circular(24),
                border: Border.all(color: AppColors.divider),
              ),
              child: TextField(
                controller: _controller,
                style: const TextStyle(color: AppColors.textPrimary, fontSize: 14),
                decoration: const InputDecoration(
                  hintText: 'Tanya kondisi lalu lintas...',
                  hintStyle: TextStyle(color: AppColors.textMuted, fontSize: 13),
                  border: InputBorder.none,
                  contentPadding: EdgeInsets.symmetric(horizontal: 16, vertical: 10),
                ),
                maxLines: 3,
                minLines: 1,
                textInputAction: TextInputAction.send,
                onSubmitted: (_) => _sendMessage(),
              ),
            ),
          ),
          const SizedBox(width: 8),
          GestureDetector(
            onTap: provider.isLoading ? null : _sendMessage,
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 200),
              width: 44,
              height: 44,
              decoration: BoxDecoration(
                color: provider.isLoading ? AppColors.surfaceLight : AppColors.primary,
                shape: BoxShape.circle,
              ),
              child: Icon(
                provider.isLoading ? Icons.hourglass_top : Icons.send,
                color: provider.isLoading ? AppColors.textMuted : AppColors.background,
                size: 20,
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _ChatBubble extends StatelessWidget {
  final bool isUser;
  final String content;
  final bool isStreaming;

  const _ChatBubble({
    required this.isUser,
    required this.content,
    this.isStreaming = false,
  });

  @override
  Widget build(BuildContext context) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: Row(
        mainAxisAlignment: isUser ? MainAxisAlignment.end : MainAxisAlignment.start,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (!isUser) ...[
            Container(
              width: 28,
              height: 28,
              decoration: BoxDecoration(
                color: AppColors.primary.withOpacity(0.15),
                shape: BoxShape.circle,
              ),
              child: const Icon(Icons.smart_toy, size: 16, color: AppColors.primary),
            ),
            const SizedBox(width: 8),
          ],
          Flexible(
            child: Container(
              padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 10),
              decoration: BoxDecoration(
                color: isUser ? AppColors.primary : AppColors.surface,
                borderRadius: BorderRadius.only(
                  topLeft: const Radius.circular(16),
                  topRight: const Radius.circular(16),
                  bottomLeft: Radius.circular(isUser ? 16 : 4),
                  bottomRight: Radius.circular(isUser ? 4 : 16),
                ),
                border: isUser ? null : Border.all(color: AppColors.divider, width: 0.5),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  if (content.isEmpty && isStreaming)
                    _typingIndicator()
                  else
                    SelectableText(
                      content,
                      style: TextStyle(
                        color: isUser ? Colors.white : AppColors.textPrimary,
                        fontSize: 13.5,
                        height: 1.5,
                      ),
                    ),
                  if (isStreaming && content.isNotEmpty) ...[
                    const SizedBox(height: 4),
                    _typingIndicator(),
                  ],
                ],
              ),
            ),
          ),
          if (isUser) const SizedBox(width: 36),
        ],
      ),
    );
  }

  Widget _typingIndicator() {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: List.generate(3, (i) {
        return TweenAnimationBuilder<double>(
          tween: Tween(begin: 0.3, end: 1.0),
          duration: Duration(milliseconds: 600 + i * 200),
          builder: (context, value, child) {
            return Opacity(
              opacity: value,
              child: Container(
                width: 6,
                height: 6,
                margin: const EdgeInsets.symmetric(horizontal: 2),
                decoration: const BoxDecoration(
                  color: AppColors.primary,
                  shape: BoxShape.circle,
                ),
              ),
            );
          },
        );
      }),
    );
  }
}
