import 'package:flutter/material.dart';
import 'package:google_fonts/google_fonts.dart';

class AppColors {
  // Base palette
  static const Color background = Color(0xFF0A1929);
  static const Color surface = Color(0xFF112240);
  static const Color surfaceLight = Color(0xFF1A3052);
  static const Color cardBg = Color(0xFF0D2137);

  // Accent
  static const Color primary = Color(0xFF4FC3F7);
  static const Color primaryDark = Color(0xFF0288D1);
  static const Color accent = Color(0xFF00E5FF);

  // Status colors
  static const Color hijau = Color(0xFF66BB6A);
  static const Color kuning = Color(0xFFFFB74D);
  static const Color merah = Color(0xFFFF5252);

  // Text
  static const Color textPrimary = Color(0xFFE0E6ED);
  static const Color textSecondary = Color(0xFF8892A4);
  static const Color textMuted = Color(0xFF5A6478);

  // Misc
  static const Color divider = Color(0xFF1E3A5F);
  static const Color shimmerBase = Color(0xFF112240);
  static const Color shimmerHighlight = Color(0xFF1A3052);

  static Color statusColor(String status) {
    switch (status.toUpperCase()) {
      case 'MERAH':
      case 'PADAT':
        return merah;
      case 'KUNING':
      case 'RAMAI':
      case 'SEDANG':
        return kuning;
      case 'HIJAU':
      case 'LANCAR':
        return hijau;
      default:
        return textSecondary;
    }
  }

  static Color riskColor(int riskScore) {
    if (riskScore >= 60) return merah;
    if (riskScore >= 20) return kuning;
    return hijau;
  }
}

class AppTheme {
  static ThemeData get darkTheme {
    return ThemeData(
      useMaterial3: true,
      brightness: Brightness.dark,
      scaffoldBackgroundColor: AppColors.background,
      colorScheme: const ColorScheme.dark(
        primary: AppColors.primary,
        secondary: AppColors.accent,
        surface: AppColors.surface,
        error: AppColors.merah,
      ),
      textTheme: GoogleFonts.interTextTheme(
        ThemeData.dark().textTheme,
      ).apply(
        bodyColor: AppColors.textPrimary,
        displayColor: AppColors.textPrimary,
      ),
      appBarTheme: AppBarTheme(
        backgroundColor: AppColors.background,
        elevation: 0,
        scrolledUnderElevation: 0,
        centerTitle: true,
        titleTextStyle: GoogleFonts.inter(
          fontSize: 18,
          fontWeight: FontWeight.w600,
          color: AppColors.textPrimary,
        ),
        iconTheme: const IconThemeData(color: AppColors.primary),
      ),
      cardTheme: CardTheme(
        color: AppColors.surface,
        elevation: 0,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(16),
          side: const BorderSide(color: AppColors.divider, width: 0.5),
        ),
      ),
      bottomNavigationBarTheme: const BottomNavigationBarThemeData(
        backgroundColor: AppColors.background,
        selectedItemColor: AppColors.primary,
        unselectedItemColor: AppColors.textMuted,
        type: BottomNavigationBarType.fixed,
        elevation: 0,
      ),
      floatingActionButtonTheme: const FloatingActionButtonThemeData(
        backgroundColor: AppColors.primary,
        foregroundColor: AppColors.background,
      ),
      chipTheme: ChipThemeData(
        backgroundColor: AppColors.surfaceLight,
        selectedColor: AppColors.primary.withOpacity(0.2),
        labelStyle: GoogleFonts.inter(
          fontSize: 12,
          color: AppColors.textPrimary,
        ),
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(20),
        ),
        side: const BorderSide(color: AppColors.divider),
      ),
    );
  }
}
