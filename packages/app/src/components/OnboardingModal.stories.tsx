import type { Meta, StoryObj } from '@storybook/react'
import OnboardingModal from '@/components/OnboardingModal'

const meta: Meta<typeof OnboardingModal> = {
  title: 'Components/OnboardingModal',
  component: OnboardingModal,
  tags: ['autodocs'],
}
export default meta

type Story = StoryObj<typeof OnboardingModal>

export const Default: Story = {
  args: {
    isOpen: true,
    onComplete: () => {},
    onSkip: () => {},
  },
}

export const Closed: Story = {
  args: {
    isOpen: false,
    onComplete: () => {},
    onSkip: () => {},
  },
}
