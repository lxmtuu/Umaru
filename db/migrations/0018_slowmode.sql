BEGIN;

-- Slowmode: giãn cách tối thiểu giữa hai tin của **cùng một người** trong kênh.
-- Lưu theo giây (0 = tắt); trần 6 giờ — Discord cho tới 6h, và lớn hơn nữa thì
-- thực chất là "khoá kênh", thứ nên làm bằng quyền chứ không bằng đồng hồ.
ALTER TABLE channels
  ADD COLUMN slowmode_seconds INTEGER NOT NULL DEFAULT 0
  CONSTRAINT channels_slowmode_range CHECK (slowmode_seconds BETWEEN 0 AND 21600);

COMMIT;
