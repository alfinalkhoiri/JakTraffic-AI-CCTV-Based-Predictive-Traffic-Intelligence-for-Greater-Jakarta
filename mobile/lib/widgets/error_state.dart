import 'package:flutter/material.dart';
import '../theme/app_theme.dart';

/// Reusable error placeholder that distinguishes a slow-backend timeout
/// from a generic network/connection failure, with a retry action.
class ErrorState extends StatelessWidget {
  final String? error;
  final VoidCallback onRetry;

  const ErrorState({super.key, this.error, required this.onRetry});

  String get _message {
    final e = error ?? '';
    if (e.contains('TimeoutException')) {
      return 'Server sedang sibuk memproses, coba lagi sebentar lagi';
    }
    return 'Gagal memuat data, periksa koneksi internet';
  }

  @override
  Widget build(BuildContext context) {
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          const Icon(Icons.error_outline, color: AppColors.merah, size: 40),
          const SizedBox(height: 8),
          Padding(
            padding: const EdgeInsets.symmetric(horizontal: 24),
            child: Text(
              _message,
              textAlign: TextAlign.center,
              style: const TextStyle(color: AppColors.textSecondary),
            ),
          ),
          TextButton(onPressed: onRetry, child: const Text('Coba Lagi')),
        ],
      ),
    );
  }
}
